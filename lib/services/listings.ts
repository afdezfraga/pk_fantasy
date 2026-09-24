/**
 * Public listings: a Pokémon on the open market at a fixed price.
 *
 * A `TradeOffer` names the club it is aimed at and has to be accepted. A listing is the other
 * shape — put a Pokémon on the board, and whichever club wants it first may simply take it at
 * the asking price. It is what "let it explore its options" means when a Pokémon comes asking
 * for a new contract: you do not pay it, and you do not stonewall it, you let the league decide
 * what it is worth.
 *
 * The asking price is frozen when the listing opens. The alternative — pricing it live off
 * `marketValue` — would move the number under a manager who is halfway through deciding, and a
 * board where the prices change while you read it is not a market.
 *
 * A listing runs on the clock rather than on rounds, and cannot be taken back while it runs. Two
 * reasons, and both are about the other clubs: a round can close in an evening, so an offer
 * measured in rounds is one half the league never sees; and a listing that could be withdrawn
 * the moment somebody showed interest would be a way to find out what your rivals want without
 * ever selling them anything. Putting a Pokémon up is a commitment, not an advertisement.
 *
 * The sale itself is a transfer, not a trip through free agency: the Pokémon keeps its value and
 * moves straight from one squad to the other, the same way `trades.ts` moves one. Selling it
 * back to the market and buying it out again would run it through `buyValue` and quietly burn a
 * share of its worth on the way past.
 */

import type { Prisma } from '@prisma/client';

import { db } from '../db.ts';
import { assertTransfersOpen } from './effects.ts';
import { audit, postEntry } from './money.ts';
import { ensureCaptain, OwnershipConflict, RosterRuleViolation, parseConfig } from './ownership.ts';

export class ListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListingError';
  }
}

/** The shortest a listing may run. Long enough that every club has had a chance to see it. */
export const LISTING_MIN_DAYS = 5;

const DAY = 24 * 60 * 60 * 1000;

export interface ListInput {
  leagueId: string;
  teamId: string;
  pokemonSlug: string;
  price: number;
  /** How long it stays up. Never less than `LISTING_MIN_DAYS`. */
  days?: number;
  /** EVENT when a decision put it there, MANAGER when somebody chose to. */
  reason?: string;
}

/** Puts a Pokémon on the board, inside a transaction the caller already opened. */
export async function openListing(tx: Prisma.TransactionClient, input: ListInput) {
  const ownership = await tx.ownership.findUnique({
    where: { leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug } },
  });
  if (!ownership || ownership.teamId !== input.teamId) {
    throw new ListingError('You no longer own that Pokémon.');
  }

  // One board entry per Pokémon. Two open listings would let two clubs each buy it.
  const existing = await tx.listing.findFirst({
    where: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug, status: 'OPEN' },
  });
  if (existing) throw new ListingError('That Pokémon is already on the market.');

  const days = Math.max(LISTING_MIN_DAYS, Math.round(input.days ?? LISTING_MIN_DAYS));
  return tx.listing.create({
    data: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: input.pokemonSlug,
      price: Math.max(0, Math.round(input.price)),
      openUntil: new Date(Date.now() + days * DAY),
      reason: input.reason ?? 'MANAGER',
    },
  });
}

/** The manager's own route onto the board, for a Pokémon no event asked about. */
export async function listForSale(input: ListInput & { actorUserId?: string | null }) {
  return db.$transaction(async (tx) => {
    await assertTransfersOpen(tx, input.leagueId, input.teamId);
    const listing = await openListing(tx, input);
    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'LISTING_OPEN',
      detail: { listingId: listing.id, pokemonSlug: input.pokemonSlug, price: listing.price },
    });
    return listing;
  });
}

/**
 * Takes a listing at its asking price.
 *
 * Guarded the same way every ownership change is: the Pokémon moves only if the club we expect
 * to own it still does, and the listing is closed by a guarded UPDATE so two managers clicking
 * at the same moment cannot both buy it.
 */
export async function buyListing(input: {
  listingId: string;
  teamId: string;
  actorUserId?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: input.listingId } });
    if (!listing) throw new ListingError('That listing is gone.');
    if (listing.status !== 'OPEN') throw new ListingError('That Pokémon has already been taken.');
    if (listing.teamId === input.teamId) {
      throw new ListingError('That is your own listing. Withdraw it instead.');
    }

    await assertTransfersOpen(tx, listing.leagueId, input.teamId);

    const league = await tx.league.findUniqueOrThrow({ where: { id: listing.leagueId } });
    const config = parseConfig(league.config);

    const ownership = await tx.ownership.findUniqueOrThrow({
      where: {
        leagueId_pokemonSlug: { leagueId: listing.leagueId, pokemonSlug: listing.pokemonSlug },
      },
      include: { pokemon: { select: { name: true, form: true } } },
    });
    const label = ownership.pokemon.form
      ? `${ownership.pokemon.name} (${ownership.pokemon.form})`
      : ownership.pokemon.name;
    if (ownership.teamId !== listing.teamId) {
      throw new OwnershipConflict(`${label} has already left that club.`);
    }

    const squadSize = await tx.ownership.count({
      where: { leagueId: listing.leagueId, teamId: input.teamId },
    });
    if (squadSize + 1 > config.squadMax) {
      throw new RosterRuleViolation(`Your squad is full at ${config.squadMax}.`);
    }
    const sellerSize = await tx.ownership.count({
      where: { leagueId: listing.leagueId, teamId: listing.teamId },
    });
    if (sellerSize - 1 < config.squadMin) {
      throw new RosterRuleViolation('The selling club cannot go below its squad minimum.');
    }

    // Close the listing first, and guarded: whoever wins this UPDATE owns the deal.
    const claimed = await tx.listing.updateMany({
      where: { id: listing.id, status: 'OPEN' },
      data: {
        status: 'SOLD',
        soldToTeamId: input.teamId,
        resolvedAt: new Date(),
      },
    });
    if (claimed.count !== 1) throw new ListingError('Somebody got there first.');

    const moved = await tx.ownership.updateMany({
      where: {
        leagueId: listing.leagueId,
        pokemonSlug: listing.pokemonSlug,
        teamId: listing.teamId,
      },
      data: {
        teamId: input.teamId,
        status: 'OWNED',
        // What the buyer paid is what it cost them; the value itself travels with the Pokémon.
        acquiredPrice: listing.price,
        acquiredAt: new Date(),
        // It arrives as a reserve — the new manager picks their own six.
        starter: false,
        slot: null,
        captain: false,
        captainSince: null,
      },
    });
    if (moved.count !== 1) {
      throw new OwnershipConflict(`${label} changed hands a moment ago.`);
    }

    // The buyer pays without `allowNegative`, so a club that cannot afford it is refused rather
    // than pushed into debt. Debt is for charges nobody can decline; this is shopping.
    await postEntry(tx, {
      leagueId: listing.leagueId,
      teamId: input.teamId,
      type: 'TRADE',
      amount: -listing.price,
      description: `Signed ${label} from the board`,
      relatedId: listing.id,
    });
    await postEntry(tx, {
      leagueId: listing.leagueId,
      teamId: listing.teamId,
      type: 'TRADE',
      amount: listing.price,
      description: `Sold ${label} off the board`,
      relatedId: listing.id,
    });

    await tx.valueChange.create({
      data: {
        leagueId: listing.leagueId,
        teamId: input.teamId,
        pokemonSlug: listing.pokemonSlug,
        reason: 'TRADE',
        delta: 0,
        valueAfter: ownership.marketValue,
        round: league.round,
      },
    });

    // A sold captain leaves the armband behind, and a squad this fills from empty gains one.
    await ensureCaptain(tx, listing.leagueId, listing.teamId);
    await ensureCaptain(tx, listing.leagueId, input.teamId);

    await audit(tx, {
      leagueId: listing.leagueId,
      actorUserId: input.actorUserId,
      action: 'LISTING_BUY',
      detail: { listingId: listing.id, pokemonSlug: listing.pokemonSlug, price: listing.price },
    });

    return { label, price: listing.price };
  });
}

/**
 * Takes a listing back off the board — which, while it is running, nobody may do.
 *
 * Kept rather than removed because a listing that has run its time and expired is a different
 * thing from one somebody is still looking at, and a future board where a club sets its own
 * longer window will want this. Today every listing runs the minimum, so this always refuses.
 */
export async function withdrawListing(input: {
  listingId: string;
  teamId: string;
  actorUserId?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: input.listingId } });
    if (!listing || listing.teamId !== input.teamId || listing.status !== 'OPEN') {
      throw new ListingError('That listing is no longer open.');
    }
    if (listing.openUntil > new Date()) {
      throw new ListingError(
        `It stays on the board until ${listing.openUntil.toDateString()}. Putting a Pokémon up is a commitment.`,
      );
    }

    await tx.listing.updateMany({
      where: { id: listing.id, status: 'OPEN' },
      data: { status: 'WITHDRAWN', resolvedAt: new Date() },
    });
    await audit(tx, {
      leagueId: listing.leagueId,
      actorUserId: input.actorUserId,
      action: 'LISTING_WITHDRAW',
      detail: { listingId: listing.id },
    });
    return { withdrawn: true };
  });
}

/**
 * Clears listings whose time is up.
 *
 * Run both when a round closes and whenever the board is read, because the clock is real time
 * and nothing else in this app ticks on its own — a league that plays nothing for a fortnight
 * would otherwise still be showing an offer that ran out ten days ago.
 */
export async function expireListings(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; round: number; now?: Date },
): Promise<number> {
  const stale = await tx.listing.findMany({
    where: { leagueId: input.leagueId, status: 'OPEN', openUntil: { lte: input.now ?? new Date() } },
  });
  if (stale.length === 0) return 0;

  await tx.listing.updateMany({
    where: { id: { in: stale.map((row) => row.id) } },
    data: { status: 'EXPIRED', resolvedAt: new Date() },
  });

  // Nobody came. The club is told, because a listing that vanishes quietly is one the manager
  // assumes is still up.
  for (const row of stale) {
    await tx.leagueEvent.create({
      data: {
        leagueId: input.leagueId,
        teamId: row.teamId,
        round: input.round,
        templateKey: 'listing:expired',
        title: 'No takers',
        description: `Nobody met the asking price. ${row.pokemonSlug} is off the market and still yours.`,
        detail: JSON.stringify({ listingId: row.id, pokemonSlug: row.pokemonSlug }),
        status: 'NOTICE',
      },
    });
  }
  return stale.length;
}

/** Everything on the board right now, dearest first. Sweeps the expired ones on the way past. */
export async function openListings(leagueId: string) {
  const league = await db.league.findUnique({ where: { id: leagueId }, select: { round: true } });
  if (league) {
    await db.$transaction((tx) => expireListings(tx, { leagueId, round: league.round }));
  }
  return db.listing.findMany({
    where: { leagueId, status: 'OPEN' },
    orderBy: { price: 'desc' },
  });
}
