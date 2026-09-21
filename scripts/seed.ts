/**
 * Loads `data/roster.json` into the Pokémon catalog.
 *
 *   npm run db:seed
 *
 * Safe to re-run: it upserts by slug, so refreshing after `npm run roster:build` updates stats
 * and prices in place without disturbing any league's ownership rows, which reference the slug.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

import type { RosterFile } from '../lib/roster/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PrismaClient();

async function main() {
  const roster: RosterFile = JSON.parse(await readFile(join(ROOT, 'data/roster.json'), 'utf8'));
  console.log(
    `Seeding ${roster.pokemon.length} Pokémon from roster generated ${roster.generatedAt} ` +
      `(wiki revision ${roster.source.revisionId}).`,
  );

  for (const entry of roster.pokemon) {
    const row = {
      dex: entry.dex,
      name: entry.name,
      form: entry.form,
      types: JSON.stringify(entry.types),
      bst: entry.bst,
      effectiveBst: entry.effectiveBst,
      tier: entry.tier,
      baseValue: entry.baseValue,
      spriteUrl: entry.spriteUrl,
      iconUrl: entry.iconUrl,
      homeUrl: entry.homeUrl,
      megas: JSON.stringify(entry.megas),
      alternateForms: JSON.stringify(entry.alternateForms),
      legal: entry.legal,
      restricted: entry.restricted,
      notes: entry.notes,
      versionAdded: entry.versionAdded,
    };
    await db.pokemon.upsert({
      where: { slug: entry.slug },
      create: { slug: entry.slug, ...row },
      update: row,
    });
  }

  const total = await db.pokemon.count();
  const legal = await db.pokemon.count({ where: { legal: true } });

  // A Pokémon in the database that the new roster no longer lists: flag rather than delete,
  // because a league may already own it and deleting would orphan that ownership.
  const stale = await db.pokemon.findMany({
    where: { slug: { notIn: roster.pokemon.map((p) => p.slug) }, legal: true },
    select: { slug: true, name: true },
  });
  if (stale.length > 0) {
    await db.pokemon.updateMany({
      where: { slug: { in: stale.map((p) => p.slug) } },
      data: { legal: false },
    });
    console.warn(
      `\n⚠  ${stale.length} Pokémon are no longer in the roster and were marked illegal:\n  ` +
        stale.map((p) => p.name).join(', ') +
        `\n   Any league that owns one should compensate its owner.`,
    );
  }

  console.log(`Catalog: ${total} Pokémon, ${legal} currently legal.`);

  // A league materialises one Ownership row per Pokémon when it's created, so anything the
  // catalog gains afterwards would be invisible to leagues that already exist. Backfill them as
  // free agents — this is what makes a roster refresh reach a league in progress.
  const leagues = await db.league.findMany({ select: { id: true, name: true } });
  const catalog = await db.pokemon.findMany({
    where: { legal: true },
    select: { slug: true, baseValue: true },
  });

  for (const league of leagues) {
    const have = new Set(
      (
        await db.ownership.findMany({
          where: { leagueId: league.id },
          select: { pokemonSlug: true },
        })
      ).map((row) => row.pokemonSlug),
    );
    const missing = catalog.filter((pokemon) => !have.has(pokemon.slug));
    if (missing.length === 0) continue;

    await db.ownership.createMany({
      data: missing.map((pokemon) => ({
        leagueId: league.id,
        pokemonSlug: pokemon.slug,
        teamId: null,
        status: 'FREE_AGENT',
        marketValue: pokemon.baseValue,
      })),
    });
    console.log(
      `Added ${missing.length} new free agent(s) to "${league.name}": ` +
        missing.map((p) => p.slug).join(', '),
    );
  }
}

main()
  .catch((error) => {
    console.error(`\nSeed failed: ${error.message}`);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
