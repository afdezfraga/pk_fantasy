/**
 * Generates `data/roster.json` and `data/roster.csv` — the league's Pokémon catalog.
 *
 *   npm run roster:build            rebuild from Bulbapedia + PokéAPI
 *   npm run roster:build -- --sprites   also download artwork into public/sprites/
 *
 * Run this when the Champions roster rotates. The output is committed to git, so a rotation
 * shows up as a reviewable diff rather than a silent change under a running league.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, betterTier, computeBaseValue, type Tier } from '../config/economy.ts';
import { resolveTiers, type TierFile } from '../lib/roster/tiers.ts';
import {
  SECTION_MAIN,
  SECTION_MEGA,
  SECTION_OTHER,
  assetKey,
  interpretAvailability,
  parentFormCode,
  parseSection,
  splitSections,
  toPokeApiSlug,
  toSlug,
  type RawRow,
} from '../lib/roster/parse.ts';
import type { AlternateForm, BaseStats, MegaForm, RosterEntry, RosterFile } from '../lib/roster/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache/pokeapi');
const DATA_DIR = join(ROOT, 'data');
const SPRITE_DIR = join(ROOT, 'public/sprites');

const WIKI_PAGE = 'List of Pokémon in Pokémon Champions';
const WIKI_URL = `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(WIKI_PAGE.replace(/ /g, '_'))}`;
const WIKI_API =
  'https://bulbapedia.bulbagarden.net/w/api.php?action=parse' +
  `&page=${encodeURIComponent(WIKI_PAGE)}&prop=wikitext|revid&format=json&formatversion=2`;

const USER_AGENT = 'pk-fantasy roster builder (self-hosted fantasy league; contact: league commissioner)';

const downloadSprites = process.argv.includes('--sprites');

// --- fetching -------------------------------------------------------------------------------

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

/** PokéAPI responses are cached on disk — ~330 requests, and we rerun this rarely. */
async function fetchPokeApi(slug: string): Promise<any | null> {
  const cachePath = join(CACHE_DIR, `${slug}.json`);
  if (existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }

  const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${slug}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PokéAPI ${response.status} for ${slug}`);

  const data = await response.json();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(data));
  await sleep(60); // be polite to a free API
  return data;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- shaping --------------------------------------------------------------------------------

const STAT_KEYS: Record<string, keyof BaseStats> = {
  hp: 'hp',
  attack: 'atk',
  defense: 'def',
  'special-attack': 'spa',
  'special-defense': 'spd',
  speed: 'spe',
};

function extractStats(api: any): BaseStats {
  const stats: BaseStats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const entry of api.stats) {
    const key = STAT_KEYS[entry.stat.name];
    if (key) stats[key] = entry.base_stat;
  }
  return stats;
}

const bstOf = (stats: BaseStats) => Object.values(stats).reduce((sum, n) => sum + n, 0);

/** Every Mega Evolution adds exactly 100 to its base form's BST — a reliable fallback. */
const MEGA_BST_GAIN = 100;

function artworkUrl(api: any): string | null {
  return api.sprites?.other?.['official-artwork']?.front_default ?? api.sprites?.front_default ?? null;
}

/**
 * Three sizes of the same Pokémon, because one image can't serve every surface: the market lists
 * 247 rows at once and needs the few-KB game sprite, while a squad card has room for the HOME
 * render. Both are captured here so the app never has to guess a URL from the artwork one.
 */
function iconUrl(api: any): string | null {
  return api.sprites?.front_default ?? null;
}

function homeUrl(api: any): string | null {
  return api.sprites?.other?.home?.front_default ?? api.sprites?.front_default ?? null;
}

/** Title-cases PokéAPI's lowercase type names to match the wiki's presentation. */
const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// --- build ----------------------------------------------------------------------------------

async function main() {
  console.log(`Fetching roster from Bulbapedia…`);
  const wiki = await fetchJson(WIKI_API);
  const wikitext: string = wiki.parse.wikitext;
  const revisionId: number = wiki.parse.revid;

  const sections = splitSections(wikitext);
  const mainRows = parseSection(sections.get(SECTION_MAIN) ?? []);
  const megaRows = parseSection(sections.get(SECTION_MEGA) ?? []);
  const otherRows = parseSection(sections.get(SECTION_OTHER) ?? []);

  if (mainRows.length === 0) {
    throw new Error(
      `Parsed 0 rows from "${SECTION_MAIN}". The wiki page layout probably changed — ` +
        `inspect the wikitext before trusting any output.`,
    );
  }
  console.log(
    `Parsed ${mainRows.length} assets, ${megaRows.length} Megas, ${otherRows.length} alternate forms ` +
      `(revision ${revisionId}).`,
  );

  // Resolve a Mega/alternate-form row to the asset that owns it.
  //
  // The usual case is an exact (dex, regional form) match. Two cases need the fallback: Mega
  // Floette is `-Mega` but its only asset is `-Eternal Flower`, and Vivillon's asset is the
  // `-High Plains` pattern while its other patterns carry their own codes. Whenever a dex has
  // exactly one asset, the form unambiguously belongs to it.
  const assetKeys = new Set(mainRows.map((r) => assetKey(r.dex, r.ig)));
  const assetsByDex = new Map<number, RawRow[]>();
  for (const row of mainRows) {
    if (!assetsByDex.has(row.dex)) assetsByDex.set(row.dex, []);
    assetsByDex.get(row.dex)!.push(row);
  }

  const unattached: string[] = [];
  function resolveParentKey(row: RawRow, parentCode: string | null, label: string): string | null {
    const exact = assetKey(row.dex, parentCode);
    if (assetKeys.has(exact)) return exact;

    const sameDex = assetsByDex.get(row.dex) ?? [];
    if (sameDex.length === 1) return assetKey(sameDex[0].dex, sameDex[0].ig);

    unattached.push(`${label} (dex ${row.dex}, ig "${row.ig}")`);
    return null;
  }

  const megasByParent = new Map<string, RawRow[]>();
  for (const row of megaRows) {
    const key = resolveParentKey(row, parentFormCode(row.ig), row.form ?? `Mega ${row.name}`);
    if (!key) continue;
    if (!megasByParent.has(key)) megasByParent.set(key, []);
    megasByParent.get(key)!.push(row);
  }

  // The "Other forms" section repeats each base row, which isn't an extra form — skip those.
  const altsByParent = new Map<string, RawRow[]>();
  for (const row of otherRows) {
    if (!row.ig) continue;
    const key = resolveParentKey(row, null, row.form ?? row.name);
    if (!key) continue;
    if (!altsByParent.has(key)) altsByParent.set(key, []);
    altsByParent.get(key)!.push(row);
  }

  if (unattached.length > 0) {
    throw new Error(
      `${unattached.length} form(s) could not be attached to any asset:\n  ` +
        unattached.join('\n  ') +
        `\n\nThese would be silently dropped. Fix the attachment rule in scripts/build-roster.ts.`,
    );
  }

  /** Unresolvable base Pokémon — fatal. A Pokémon silently vanishing from the league is worse
   *  than a failed build. */
  const missing: string[] = [];
  /** Forms priced by inference rather than data — surfaced as a warning, not a failure. */
  const estimated: string[] = [];
  const entries: RosterEntry[] = [];

  console.log('Enriching from PokéAPI…');
  for (const [index, row] of mainRows.entries()) {
    const slug = toSlug(row.name, row.ig);
    const pokeapiSlug = toPokeApiSlug(row.name, row.ig);
    const api = await fetchPokeApi(pokeapiSlug);
    if (!api) {
      missing.push(`${row.name}${row.ig ?? ''} → ${pokeapiSlug}`);
      continue;
    }

    const stats = extractStats(api);
    const key = assetKey(row.dex, row.ig);

    // Champions includes Megas introduced in Legends: Z-A that PokéAPI hasn't catalogued yet
    // (Mega Meowstic, at time of writing). Those must not sink the build: every Mega Evolution
    // adds exactly +100 BST, so fall back to that and flag it as an estimate.
    const megas: MegaForm[] = [];
    for (const megaRow of megasByParent.get(key) ?? []) {
      const megaSlug = toSlug(megaRow.name, megaRow.ig);
      const megaApi = await fetchPokeApi(toPokeApiSlug(megaRow.name, megaRow.ig));
      const label = megaRow.form ?? `Mega ${megaRow.name}`;

      if (!megaApi) {
        estimated.push(`${label} (${toPokeApiSlug(megaRow.name, megaRow.ig)})`);
        megas.push({
          slug: megaSlug,
          label,
          types: megaRow.types,
          stats: null,
          bst: bstOf(stats) + MEGA_BST_GAIN,
          bstEstimated: true,
          spriteUrl: null,
          iconUrl: null,
          homeUrl: null,
          tier: 'UR',
        });
        continue;
      }

      const megaStats = extractStats(megaApi);
      megas.push({
        slug: megaSlug,
        label,
        types: megaApi.types.map((t: any) => titleCase(t.type.name)),
        stats: megaStats,
        bst: bstOf(megaStats),
        bstEstimated: false,
        spriteUrl: artworkUrl(megaApi),
        iconUrl: iconUrl(megaApi),
        homeUrl: homeUrl(megaApi),
        tier: 'UR',
      });
    }

    // Alternate forms are display-only, but their BST feeds pricing: a Pokémon that transforms
    // mid-battle (Palafin → Hero) is worth what it becomes, not what it starts as. Cosmetic
    // patterns PokéAPI doesn't model separately are kept with a null BST rather than failing.
    const alternateForms: AlternateForm[] = [];
    for (const alt of altsByParent.get(key) ?? []) {
      const altSlug = toSlug(alt.name, alt.ig);
      const altApi = await fetchPokeApi(toPokeApiSlug(alt.name, alt.ig));
      alternateForms.push({
        slug: altSlug,
        label: alt.form ?? alt.name,
        types: alt.types,
        bst: altApi ? bstOf(extractStats(altApi)) : null,
      });
    }

    const { legal, restricted, notes } = interpretAvailability(row.available);
    const bst = bstOf(stats);

    entries.push({
      slug,
      pokeapiSlug,
      dex: row.dex,
      name: row.name,
      form: row.form,
      types: row.types,
      stats,
      bst,
      megas,
      alternateForms,
      spriteUrl: artworkUrl(api),
      iconUrl: iconUrl(api),
      homeUrl: homeUrl(api),
      legal,
      restricted,
      notes,
      versionAdded: row.versionAdded,
      // Tier and price need the whole roster in hand to resolve names — filled in below.
      tier: 'UR',
      effectiveBst: Math.max(
        bst,
        ...megas.map((m) => m.bst),
        ...alternateForms.map((f) => f.bst).filter((b): b is number => b !== null),
      ),
      baseValue: 0,
    });

    if ((index + 1) % 50 === 0) console.log(`  …${index + 1}/${mainRows.length}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `${missing.length} Pokémon could not be resolved on PokéAPI:\n  ` +
        missing.join('\n  ') +
        `\n\nAdd the correct slug to SLUG_ALIASES in lib/roster/parse.ts and rerun.`,
    );
  }

  if (estimated.length > 0) {
    console.warn(
      `\n⚠  ${estimated.length} Mega form(s) are not in PokéAPI yet; BST inferred as base + ${MEGA_BST_GAIN}:\n  ` +
        estimated.join('\n  ') +
        `\n   Check their prices by hand in data/roster.csv.`,
    );
  }

  // --- tiers and pricing -------------------------------------------------------------------
  //
  // A Pokémon is priced at the best tier it can reach, counting its Megas: owning Charizard
  // grants Mega Charizard Y (A+), so Charizard is an A+ asset even though it is C on its own.

  const tierFile: TierFile = JSON.parse(await readFile(join(DATA_DIR, 'tiers.json'), 'utf8'));
  const resolved = resolveTiers(tierFile, entries);

  if (resolved.unmatched.length > 0) {
    console.warn(
      `\n⚠  ${resolved.unmatched.length} tier-list name(s) matched no Pokémon in the roster:\n  ` +
        resolved.unmatched.join('\n  ') +
        `\n   They are either misspelled in data/tiers.json or no longer in Champions.`,
    );
  }

  for (const entry of entries) {
    const own = resolved.bySlug.get(entry.slug) ?? tierFile.defaultTier;

    // Only let a Mega raise its species' tier when the tier list ranks base forms in isolation.
    // The doubles list already bakes Mega access into the base ranking, so applying it again
    // would promote Eelektross and Scrafty to S on the strength of a Mega already counted.
    const viaMega = tierFile.baseTiersIncludeMegas
      ? []
      : entry.megas
          .map((m) => resolved.byMegaSlug.get(m.slug))
          .filter((t): t is Tier => t !== undefined);

    entry.tier = viaMega.reduce<Tier>((best, t) => betterTier(best, t), own);
    entry.baseValue = computeBaseValue({ tier: entry.tier, effectiveBst: entry.effectiveBst });
    for (const mega of entry.megas) {
      mega.tier = resolved.byMegaSlug.get(mega.slug) ?? tierFile.defaultTier;
    }
  }

  entries.sort((a, b) => a.dex - b.dex || a.slug.localeCompare(b.slug));

  const roster: RosterFile = {
    generatedAt: new Date().toISOString(),
    source: { page: WIKI_PAGE, revisionId, url: WIKI_URL },
    counts: {
      assets: entries.length,
      species: new Set(entries.map((e) => e.dex)).size,
      regionalForms: entries.filter((e) => e.form).length,
      megas: entries.reduce((sum, e) => sum + e.megas.length, 0),
      alternateForms: entries.reduce((sum, e) => sum + e.alternateForms.length, 0),
      legal: entries.filter((e) => e.legal).length,
    },
    pokemon: entries,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(join(DATA_DIR, 'roster.json'), `${JSON.stringify(roster, null, 2)}\n`);
  await writeFile(join(DATA_DIR, 'roster.csv'), toCsv(entries));

  if (downloadSprites) await saveSprites(entries);

  console.table(roster.counts);

  const byTier = TIERS.map((tier) => {
    const inTier = entries.filter((e) => e.tier === tier);
    return {
      tier,
      count: inTier.length,
      price: inTier.length
        ? `₽${Math.min(...inTier.map((e) => e.baseValue)).toLocaleString()} – ` +
          `₽${Math.max(...inTier.map((e) => e.baseValue)).toLocaleString()}`
        : '—',
    };
  });
  console.table(byTier);

  console.log(`Wrote data/roster.json and data/roster.csv`);
}

/** Hand-editable view. `valueOverride` is the column you fill in to rebalance a Pokémon. */
function toCsv(entries: RosterEntry[]): string {
  const header = [
    'slug',
    'dex',
    'name',
    'form',
    'types',
    'tier',
    'bst',
    'effectiveBst',
    'megas',
    'bestMegaTier',
    'legal',
    'notes',
    'versionAdded',
    'baseValue',
    'valueOverride',
  ];
  const rows = entries.map((e) =>
    [
      e.slug,
      e.dex,
      e.name,
      e.form ?? '',
      e.types.join('/'),
      e.tier,
      e.bst,
      e.effectiveBst,
      e.megas.map((m) => `${m.label} [${m.tier}]`).join(' | '),
      e.megas.length ? e.megas.map((m) => m.tier).sort()[0] : '',
      e.legal ? 'yes' : 'no',
      e.notes ?? '',
      e.versionAdded,
      e.baseValue,
      '',
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[header.join(','), ...rows].join('\n')}\n`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function saveSprites(entries: RosterEntry[]) {
  await mkdir(SPRITE_DIR, { recursive: true });
  const targets = entries.flatMap((e) => [
    { slug: e.slug, url: e.spriteUrl },
    ...e.megas.map((m) => ({ slug: m.slug, url: m.spriteUrl })),
  ]);

  let saved = 0;
  for (const { slug, url } of targets) {
    if (!url) continue;
    const path = join(SPRITE_DIR, `${slug}.png`);
    if (existsSync(path)) continue;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) {
      console.warn(`  sprite ${slug}: ${response.status}`);
      continue;
    }
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    saved += 1;
  }
  console.log(`Saved ${saved} sprites to public/sprites/`);
}

main().catch((error) => {
  console.error(`\nRoster build failed:\n${error.message}`);
  process.exit(1);
});
