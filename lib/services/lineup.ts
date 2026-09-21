/**
 * The starting lineup: which of a squad's Pokémon are match-eligible.
 *
 * A squad can hold up to `squadMax` Pokémon, but only `lineupSize` of them are starters, and only
 * a starter can appear in a reported match. That's what stops a deep squad being a free upgrade —
 * signing a twelfth Pokémon means benching one of your six, not stacking them.
 *
 * `Ownership.starter` is the flag. It is written here and cleared by `lib/services/ownership.ts`
 * and `lib/services/trades.ts` whenever a Pokémon leaves a squad, so a sale can never leave a
 * phantom slot filled.
 */

import type { Prisma } from '@prisma/client';

import type { LeagueConfig } from '../../config/economy.ts';
import { db } from '../db.ts';
import { audit } from './money.ts';
import { parseConfig, RosterRuleViolation } from './ownership.ts';

/**
 * Gives a team a sensible lineup if it has none at all.
 *
 * This is what keeps "only starters may play" from becoming a gate. A team that has just drafted,
 * or a league that predates the lineup feature, would otherwise have zero starters and be unable
 * to report anything until it visited the squad page — a dead end on the very first match.
 *
 * Deliberately only fires at *zero*: a manager who has benched down to three starters has made a
 * choice, and refilling it behind their back would undo it.
 */
export async function ensureLineup(
  tx: Prisma.TransactionClient,
  leagueId: string,
  teamId: string,
  config: LeagueConfig,
): Promise<void> {
  const starters = await tx.ownership.count({ where: { leagueId, teamId, starter: true } });
  if (starters > 0) return;

  const squad = await tx.ownership.findMany({
    where: { leagueId, teamId },
    orderBy: { marketValue: 'desc' },
    take: config.lineupSize,
    select: { id: true },
  });
  if (squad.length === 0) return;

  await tx.ownership.updateMany({
    where: { id: { in: squad.map((row) => row.id) } },
    data: { starter: true },
  });
}

/** The squad split into starters and reserves, each richest first. */
export async function getLineup(leagueId: string, teamId: string) {
  const league = await db.league.findUniqueOrThrow({ where: { id: leagueId } });
  const config = parseConfig(league.config);

  await db.$transaction(async (tx) => ensureLineup(tx, leagueId, teamId, config));

  // Squad order is the manager's own: the shirt numbers they dragged the cards into. Rows with
  // no number yet (a league from before the board existed) fall in behind, dearest first.
  const squad = await db.ownership.findMany({
    where: { leagueId, teamId },
    include: { pokemon: true },
    orderBy: [{ slot: { sort: 'asc', nulls: 'last' } }, { marketValue: 'desc' }],
  });

  return {
    config,
    starters: squad.filter((row) => row.starter),
    reserves: squad.filter((row) => !row.starter),
  };
}

/**
 * Writes a whole lineup at once: who starts, who sits, and the order of both.
 *
 * This is what the drag-and-drop board posts. It replaces the squad's arrangement wholesale
 * rather than applying a diff, so a drag that moves two cards is one atomic write and there is
 * no window where seven Pokémon are starting.
 *
 * The lists together must be exactly the squad — not a subset — so a stale board can't quietly
 * bench a Pokémon signed in another tab.
 */
export async function setLineup(input: {
  leagueId: string;
  teamId: string;
  /** In shirt-number order. */
  starters: string[];
  reserves: string[];
  actorUserId?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const league = await tx.league.findUniqueOrThrow({ where: { id: input.leagueId } });
    const config = parseConfig(league.config);

    if (input.starters.length > config.lineupSize) {
      throw new RosterRuleViolation(`Only ${config.lineupSize} Pokémon can start.`);
    }

    const squad = await tx.ownership.findMany({
      where: { leagueId: input.leagueId, teamId: input.teamId },
      select: { id: true, pokemonSlug: true },
    });

    const posted = [...input.starters, ...input.reserves];
    const owned = new Set(squad.map((row) => row.pokemonSlug));
    const unique = new Set(posted);
    if (unique.size !== posted.length || posted.length !== owned.size) {
      throw new RosterRuleViolation('That lineup no longer matches your squad — reload the page.');
    }
    for (const slug of posted) {
      if (!owned.has(slug)) {
        throw new RosterRuleViolation('That lineup no longer matches your squad — reload the page.');
      }
    }

    const idBySlug = new Map(squad.map((row) => [row.pokemonSlug, row.id]));
    const starting = new Set(input.starters);
    for (const [index, slug] of posted.entries()) {
      await tx.ownership.update({
        where: { id: idBySlug.get(slug)! },
        data: { starter: starting.has(slug), slot: index + 1 },
      });
    }

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'LINEUP_SET',
      detail: { teamId: input.teamId, starters: input.starters },
    });

    return { starters: input.starters.length };
  });
}

/**
 * Promotes a reserve into the lineup, or benches a starter.
 *
 * Guarded on the current flag as well as the owner, so two taps racing each other can't both
 * count against the lineup limit and leave a seventh starter behind.
 */
export async function setStarter(input: {
  leagueId: string;
  teamId: string;
  pokemonSlug: string;
  starter: boolean;
  actorUserId?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const league = await tx.league.findUniqueOrThrow({ where: { id: input.leagueId } });
    const config = parseConfig(league.config);

    const ownership = await tx.ownership.findUnique({
      where: {
        leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug },
      },
      include: { pokemon: { select: { name: true, form: true } } },
    });
    if (!ownership || ownership.teamId !== input.teamId) {
      throw new RosterRuleViolation("That Pokémon isn't on your squad.");
    }

    const label = ownership.pokemon.form
      ? `${ownership.pokemon.name} (${ownership.pokemon.form})`
      : ownership.pokemon.name;

    if (ownership.starter === input.starter) return { label, starter: input.starter };

    if (input.starter) {
      const starters = await tx.ownership.count({
        where: { leagueId: input.leagueId, teamId: input.teamId, starter: true },
      });
      if (starters >= config.lineupSize) {
        throw new RosterRuleViolation(
          `Your lineup is full at ${config.lineupSize}. Bench someone before starting ${label}.`,
        );
      }
    }

    const changed = await tx.ownership.updateMany({
      where: {
        leagueId: input.leagueId,
        pokemonSlug: input.pokemonSlug,
        teamId: input.teamId,
        starter: !input.starter,
      },
      data: { starter: input.starter },
    });
    if (changed.count !== 1) {
      throw new RosterRuleViolation(`${label} moved before that went through.`);
    }

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'LINEUP_SET',
      detail: { pokemonSlug: input.pokemonSlug, teamId: input.teamId, starter: input.starter },
    });

    return { label, starter: input.starter };
  });
}
