/**
 * Every change of ownership goes through this module. Nothing else may write `Ownership.teamId`.
 *
 * The league's central rule — at most one team owns each Pokémon — is enforced in two places
 * that back each other up:
 *
 *  1. `@@unique([leagueId, pokemonSlug])` in the schema means a Pokémon has exactly one row.
 *  2. Every acquisition is a *guarded* UPDATE that names the owner it expects to be replacing
 *     (`teamId: null` for a free agent, or the selling team for a trade). If someone else got
 *     there first, the WHERE clause matches zero rows and we know we lost the race — rather
 *     than reading, deciding, and writing over the top of them.
 *
 * That second point is why the checks aren't a read-then-write: on a fast draft or a popular
 * free agent, two people really do click at the same moment.
 *
 * Each guarded write comes in two forms. `claimFreeAgent` and `releaseToMarket` do the work
 * inside a transaction the caller already opened; `acquireFreeAgent` and `sellToMarket` open one
 * and hand it straight over. Events need the first pair, because handing a Pokémon over means
 * releasing and signing atomically and SQLite will not nest a transaction — and the alternative
 * was letting events write `Ownership.teamId` themselves, which is the one thing this module
 * exists to prevent.
 */

import type { Prisma } from '@prisma/client';

import { buyValue, LEAGUE_DEFAULTS, VALUE_RULES, type LeagueConfig } from '../../config/economy.ts';
import { db } from '../db.ts';
import { assertTransfersOpen } from './effects.ts';
import { audit, postEntry, type TransactionType } from './money.ts';
import { recordValue } from './value.ts';

export class OwnershipConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipConflict';
  }
}

export class RosterRuleViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterRuleViolation';
  }
}

export function parseConfig(raw: string): LeagueConfig {
  return { ...LEAGUE_DEFAULTS, ...JSON.parse(raw) };
}

interface AcquireInput {
  leagueId: string;
  pokemonSlug: string;
  teamId: string;
  price: number;
  type: TransactionType;
  actorUserId?: string | null;
  /** Skips the legality and squad-size checks. Only the commissioner's tools should do this. */
  force?: boolean;
}

/**
 * Moves a free agent onto a team, charging the team for it.
 *
 * The team pays the full price, but the Pokémon is then only worth `buyValue(price)` — signing
 * and immediately selling loses money.
 *
 * Throws `OwnershipConflict` if another team took it first, `InsufficientFunds` if the team
 * can't pay, and `RosterRuleViolation` if it would break the squad limit.
 */
export async function acquireFreeAgent(input: AcquireInput) {
  return db.$transaction((tx) => claimFreeAgent(tx, input));
}

/**
 * The same acquisition, inside a transaction somebody else opened.
 *
 * Events need this: answering "release one, sign two" has to release and sign in one atomic
 * step, and SQLite will not nest a transaction inside a transaction. Rather than let events
 * write `Ownership.teamId` themselves — the one rule this module exists to protect — the
 * guarded write moves here and `acquireFreeAgent` becomes a caller like any other.
 */
export async function claimFreeAgent(tx: Prisma.TransactionClient, input: AcquireInput) {
  const league = await tx.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  const config = parseConfig(league.config);

  const ownership = await tx.ownership.findUnique({
    where: { leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug } },
    include: {
      pokemon: { select: { name: true, form: true, legal: true, restricted: true, notes: true } },
    },
  });
  if (!ownership) throw new OwnershipConflict('That Pokémon is not part of this league.');

  const label = ownership.pokemon.form
    ? `${ownership.pokemon.name} (${ownership.pokemon.form})`
    : ownership.pokemon.name;

  if (!ownership.pokemon.legal && !input.force) {
    throw new RosterRuleViolation(`${label} is no longer on the Champions roster.`);
  }
  // Restricted means "on the roster but you can't just catch one" — transfer-only or
  // event-only. Whether that's allowed is the league's call, not the roster's.
  if (ownership.pokemon.restricted && !config.allowTransferOnly && !input.force) {
    throw new RosterRuleViolation(
      `${label} is ${(ownership.pokemon.notes ?? 'restricted').toLowerCase()}, and this league doesn't allow those.`,
    );
  }
  if (ownership.teamId) {
    throw new OwnershipConflict(`${label} is already owned.`);
  }

  // A frozen club may still be handed a Pokémon by an event or a draft — it just can't shop.
  if (input.type === 'MARKET_BUY') await assertTransfersOpen(tx, input.leagueId, input.teamId);

  if (!input.force) await assertRosterRules(tx, input.teamId, config);

  // A signing walks straight into the lineup while there's room for it. Without this, a team
  // finishes its draft with six Pokémon and no starters, and can't report a match until it has
  // been to the squad page — a gate on the very first thing anyone wants to do.
  const starters = await tx.ownership.count({
    where: { leagueId: input.leagueId, teamId: input.teamId, starter: true },
  });
  // New signings take the next shirt number.
  const lastSlot = await tx.ownership.aggregate({
    where: { leagueId: input.leagueId, teamId: input.teamId },
    _max: { slot: true },
  });

  // The guarded write. `teamId: null` is the assertion that it is still a free agent.
  const claimed = await tx.ownership.updateMany({
    where: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug, teamId: null },
    data: {
      teamId: input.teamId,
      status: 'OWNED',
      acquiredPrice: input.price,
      acquiredAt: new Date(),
      waiverUntil: null,
      starter: starters < config.lineupSize,
      slot: (lastSlot._max.slot ?? 0) + 1,
    },
  });
  if (claimed.count !== 1) {
    throw new OwnershipConflict(`${label} was claimed by someone else a moment ago.`);
  }

  // The first Pokémon into an empty squad takes the armband — in a draft, the first pick.
  await ensureCaptain(tx, input.leagueId, input.teamId);

  if (input.price !== 0) {
    await postEntry(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      type: input.type,
      amount: -input.price,
      description: `Signed ${label}`,
      relatedId: ownership.id,
    });
  }

  // A free signing (commissioner tools) keeps the shop price as its value: there was no
  // purchase to lose money on.
  const paid = input.price > 0;
  const value = paid ? buyValue(input.price) : ownership.marketValue;
  await recordValue(tx, {
    ownershipId: ownership.id,
    leagueId: input.leagueId,
    teamId: input.teamId,
    pokemonSlug: input.pokemonSlug,
    reason: 'BUY',
    from: paid ? input.price : ownership.marketValue,
    to: value,
    pct: paid ? VALUE_RULES.buyKeepPct - 100 : 0,
    round: league.round,
  });

  await audit(tx, {
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    action: input.type,
    detail: { pokemonSlug: input.pokemonSlug, teamId: input.teamId, price: input.price, value },
  });

  return { ownershipId: ownership.id, label, value };
}

/**
 * Releases a Pokémon back to the market, paying the owner its current value.
 *
 * There's no extra haircut: the loss already happened at signing, when the value dropped below
 * the price. The Pokémon goes back on the shelf at its shop price.
 */
export async function sellToMarket(input: {
  leagueId: string;
  pokemonSlug: string;
  teamId: string;
  actorUserId?: string | null;
}) {
  return db.$transaction((tx) => releaseToMarket(tx, input));
}

export interface ReleaseInput {
  leagueId: string;
  pokemonSlug: string;
  teamId: string;
  actorUserId?: string | null;
  /**
   * What the club is paid, if not the Pokémon's market value. A swap pays nothing: the club is
   * getting another Pokémon back, not cash.
   */
  proceeds?: number;
  type?: TransactionType;
  description?: string;
  /**
   * Skips the squad-minimum check. Only for a release followed by an acquisition in the *same*
   * transaction, where the squad is never actually left short — an event swap, not a sale.
   */
  skipSquadMin?: boolean;
}

/** The guarded release, inside a transaction somebody else opened. See `claimFreeAgent`. */
export async function releaseToMarket(tx: Prisma.TransactionClient, input: ReleaseInput) {
  const league = await tx.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  const config = parseConfig(league.config);

  const ownership = await tx.ownership.findUnique({
    where: { leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug } },
    include: { pokemon: { select: { name: true, form: true, baseValue: true } } },
  });
  if (!ownership) throw new OwnershipConflict('That Pokémon is not part of this league.');

  const label = ownership.pokemon.form
    ? `${ownership.pokemon.name} (${ownership.pokemon.form})`
    : ownership.pokemon.name;

  if (ownership.teamId !== input.teamId) {
    throw new OwnershipConflict(`You don't own ${label}.`);
  }

  // A sale is the club dealing; an event handing a Pokémon back is not.
  if (input.type === undefined || input.type === 'MARKET_SELL') {
    await assertTransfersOpen(tx, input.leagueId, input.teamId);
  }

  const squadSize = await tx.ownership.count({
    where: { leagueId: input.leagueId, teamId: input.teamId },
  });
  if (!input.skipSquadMin && squadSize - 1 < config.squadMin) {
    throw new RosterRuleViolation(
      `Your squad can't drop below ${config.squadMin} Pokémon. Sign someone first.`,
    );
  }

  const proceeds = input.proceeds ?? ownership.marketValue;

  // Guarded on the current owner, so a trade that lands first can't be overwritten.
  const released = await tx.ownership.updateMany({
    where: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug, teamId: input.teamId },
    data: {
      teamId: null,
      status: 'WAIVERS',
      acquiredPrice: 0,
      acquiredAt: null,
      contractUntil: null,
      // Leaving these set would keep a sold Pokémon occupying a lineup slot nobody can see.
      starter: false,
      slot: null,
      captain: false,
      marketValue: ownership.pokemon.baseValue,
    },
  });
  if (released.count !== 1) {
    throw new OwnershipConflict(`${label} moved before the sale went through.`);
  }

  // Selling the captain hands the armband on rather than leaving the club without one.
  if (ownership.captain) await ensureCaptain(tx, input.leagueId, input.teamId);

  await tx.valueChange.create({
    data: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: input.pokemonSlug,
      reason: 'SELL',
      delta: 0,
      valueAfter: proceeds,
      round: league.round,
    },
  });

  // A release that pays nothing posts nothing: the ledger records movements of money, and a
  // straight swap moves none. `postEntry` rejects a zero amount anyway.
  if (proceeds !== 0) {
    await postEntry(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      type: input.type ?? 'MARKET_SELL',
      amount: proceeds,
      description: input.description ?? `Released ${label}`,
      relatedId: ownership.id,
    });
  }

  await audit(tx, {
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    action: input.type ?? 'MARKET_SELL',
    detail: { pokemonSlug: input.pokemonSlug, teamId: input.teamId, proceeds },
  });

  return { label, proceeds };
}

/**
 * Gives a squad a captain if it has none. A club with any Pokémon always has one.
 *
 * The armband goes to the longest-serving member, which is also what makes the first draft pick
 * the captain: it is the first one in. Called after every change of owner, so the only way to
 * lose a captain is to sell the whole squad.
 */
export async function ensureCaptain(
  tx: Prisma.TransactionClient,
  leagueId: string,
  teamId: string,
): Promise<void> {
  const current = await tx.ownership.count({ where: { leagueId, teamId, captain: true } });
  if (current > 0) return;

  const successor = await tx.ownership.findFirst({
    where: { leagueId, teamId },
    orderBy: [
      { acquiredAt: { sort: 'asc', nulls: 'last' } },
      { slot: { sort: 'asc', nulls: 'last' } },
      { marketValue: 'desc' },
    ],
    select: { id: true },
  });
  if (!successor) return;

  // Stamped so events can ask how long it has worn the armband. A club that inherits one this
  // way — first draft pick, or a sale passing it on — starts its tenure now.
  await tx.ownership.update({
    where: { id: successor.id },
    data: { captain: true, captainSince: new Date() },
  });
}

/** Squad-size check, shared by every acquisition path. */
async function assertRosterRules(
  tx: Prisma.TransactionClient,
  teamId: string,
  config: LeagueConfig,
): Promise<void> {
  const owned = await tx.ownership.count({ where: { teamId } });
  if (owned + 1 > config.squadMax) {
    throw new RosterRuleViolation(
      `Squad is full at ${config.squadMax} Pokémon. Release someone first.`,
    );
  }
}

/** Current squad, richest first — the shape every team view needs. */
export async function getSquad(leagueId: string, teamId: string) {
  return db.ownership.findMany({
    where: { leagueId, teamId },
    include: { pokemon: true },
    orderBy: { marketValue: 'desc' },
  });
}
