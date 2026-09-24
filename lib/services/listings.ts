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

/**
 * How long a listing a *decision* put up must run. Long enough that every club has had a chance
 * to see it, and the deck is validated against it so no event can post a token one.
 */
export const LISTING_MIN_DAYS = 5;

/**
 * The window a manager may choose from.
 *
 * An hour is short enough to be a real tactic — put something up at a price, see if anyone bites
 * before tonight's matches — and a week is long enough that nothing sits on the board forever
 * being forgotten about.
 */
export const LISTING_MIN_HOURS = 1;
export const LISTING_MAX_HOURS = 7 * 24;

const HOUR = 60 * 60 * 1000;

export interface ListInput {
  leagueId: string;
  teamId: string;
  pokemonSlug: string;
  price: number;
  /** How long it stays up, in hours. Clamped to the manager's window unless an event set it. */
  hours?: number;
  /** EVENT when a decision put it there, MANAGER when somebody chose to. */
  reason?: string;
}

/** An event's listing is a consequence, not an offer: the club does not get to take it back. */
export function isLocked(listing: { reason: string; status: string }): boolean {
  return listing.status === 'OPEN' && listing.reason === 'EVENT';
}

/** Puts a Pokémon on the board, inside a transaction the caller already opened. */
export async function openListing(tx: Prisma.TransactionClient, input: ListInput) {
  const ownership = await tx.ownership.findUnique({
    where: { leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug } },
  });
  if (!ownership || ownership.teamId !== input.teamId) {
    throw new ListingError('You no longer own that Pokémon.');
  }

  // One board entry per Pokémon, always. Two open listings would let two clubs each buy it.
  const existing = await tx.listing.findFirst({
    where: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug, status: 'OPEN' },
  });

  const fromEvent = (input.reason ?? 'MANAGER') === 'EVENT';

  if (existing) {
    // A manager cannot list the same Pokémon twice; they must take the first one down.
    if (!fromEvent) throw new ListingError('That Pokémon is already on the market.');

    // A decision outranks a choice. Putting your Pokémon up at your own price is not a way to
    // pre-empt what an event is about to do with it, so the event's terms replace yours.
    await tx.listing.updateMany({
      where: { id: existing.id, status: 'OPEN' },
      data: { status: 'SUPERSEDED', resolvedAt: new Date() },
    });
  }

  const hours = fromEvent
    ? Math.max(LISTING_MIN_DAYS * 24, Math.round(input.hours ?? LISTING_MIN_DAYS * 24))
    : Math.min(LISTING_MAX_HOURS, Math.max(LISTING_MIN_HOURS, Math.round(input.hours ?? 24)));

  return tx.listing.create({
    data: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: input.pokemonSlug,
      price: Math.max(0, Math.round(input.price)),
      openUntil: new Date(Date.now() + hours * HOUR),
      reason: fromEvent ? 'EVENT' : 'MANAGER',
    },
  });
}

/**
 * Takes a Pokémon's listing off the board because the Pokémon itself has gone.
 *
 * Every path that moves a Pokémon between squads calls this. A listing is a promise to sell
 * something you own, so the moment you stop owning it the promise has to go with it — otherwise
 * the board advertises a Pokémon its seller cannot deliver, and the buyer's guarded UPDATE fails
 * with a conflict they did nothing to cause.
 */
export async function cancelListingsFor(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; pokemonSlug: string },
): Promise<number> {
  const { count } = await tx.listing.updateMany({
    where: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug, status: 'OPEN' },
    data: { status: 'CANCELLED', resolvedAt: new Date() },
  });
  return count;
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
 * Takes a listing back off the board.
 *
 * A manager may do this whenever they like. The earlier rule — that putting a Pokémon up was a
 * commitment for the whole window — was there to stop a club fishing for who wanted what and
 * pulling the listing the moment somebody showed interest. That worry does not survive contact
 * with a board where the seller also chooses the window: anyone who wants to fish can simply
 * post for an hour. What it actually cost was the ordinary case, a manager who changed their
 * mind and had to watch their own squad be sold out from under them for five days.
 *
 * An event's listing is the exception, and the reason the distinction exists: that one is a
 * consequence of a decision already taken, so the club does not get to undo it by clicking.
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
    if (isLocked(listing)) {
      throw new ListingError(
        'A decision put that one on the board, so it stays there until it runs out or somebody takes it.',
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
