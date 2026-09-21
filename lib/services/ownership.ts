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
 */

import type { Prisma } from '@prisma/client';

import { buyValue, LEAGUE_DEFAULTS, VALUE_RULES, type LeagueConfig } from '../../config/economy.ts';
import { db } from '../db.ts';
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
  return db.$transaction(async (tx) => {
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
  });
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
  return db.$transaction(async (tx) => {
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

    const squadSize = await tx.ownership.count({
      where: { leagueId: input.leagueId, teamId: input.teamId },
    });
    if (squadSize - 1 < config.squadMin) {
      throw new RosterRuleViolation(
        `Your squad can't drop below ${config.squadMin} Pokémon. Sign someone first.`,
      );
    }

    const proceeds = ownership.marketValue;

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

    await postEntry(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      type: 'MARKET_SELL',
      amount: proceeds,
      description: `Released ${label}`,
      relatedId: ownership.id,
    });

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'MARKET_SELL',
      detail: { pokemonSlug: input.pokemonSlug, teamId: input.teamId, proceeds },
    });

    return { label, proceeds };
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
