/**
 * Listings against a real database. The things worth testing are the ones a board gets wrong:
 * that two clubs cannot both take the same Pokémon, that the money balances, and that a listing
 * cannot be pulled out from under somebody who is looking at it.
 */

import { describe, expect, it } from 'vitest';

import { db } from '../db.ts';
import {
  buyListing,
  expireListings,
  listForSale,
  LISTING_MIN_DAYS,
  ListingError,
  openListings,
  withdrawListing,
} from './listings.ts';
import { createLeague, joinLeague } from './league.ts';
import { postEntry, verifyLedger } from './money.ts';
import { acquireFreeAgent } from './ownership.ts';

let counter = 0;

async function makeLeague(extraTeams = 0) {
  counter += 1;
  const users = await Promise.all(
    [0, 1].map((index) =>
      db.user.create({
        data: { username: `li-${counter}-${index}`, displayName: `P${index}`, passwordHash: 'x' },
      }),
    ),
  );
  const { league, team } = await createLeague({
    name: `Listings ${counter}`,
    commissionerId: users[0].id,
    teamName: 'Sellers',
    config: { startingCash: 1_000_000 },
  });
  const { team: other } = await joinLeague({
    inviteCode: league.inviteCode,
    userId: users[1].id,
    teamName: 'Buyers',
  });

  for (const [slug, teamId] of [
    ['incineroar', team.id],
    ['garchomp', team.id],
    ['whimsicott', other.id],
    ['torkoal', other.id],
  ] as const) {
    const row = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: slug } },
    });
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: slug,
      teamId,
      price: row.marketValue,
      type: 'DRAFT_PICK',
    });
  }
  const extras = [];
  for (let index = 0; index < extraTeams; index += 1) {
    const user = await db.user.create({
      data: { username: `li-${counter}-x${index}`, displayName: `X${index}`, passwordHash: 'x' },
    });
    const joined = await joinLeague({
      inviteCode: league.inviteCode,
      userId: user.id,
      teamName: `Rival ${index}`,
    });
    extras.push(joined.team);
  }

  await db.league.update({ where: { id: league.id }, data: { status: 'ACTIVE' } });
  return { league, team, other, extras, users };
}

async function list(leagueId: string, teamId: string, slug: string, price: number) {
  return listForSale({ leagueId, teamId, pokemonSlug: slug, price });
}

describe('putting a Pokémon on the board', () => {
  it('moves it to whoever signs it, and the money with it', async () => {
    const { league, team, other, users } = await makeLeague();
    const before = {
      seller: (await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash,
      buyer: (await db.team.findUniqueOrThrow({ where: { id: other.id } })).cash,
    };

    const listing = await list(league.id, team.id, 'incineroar', 132_000);
    const result = await buyListing({
      listingId: listing.id,
      teamId: other.id,
      actorUserId: users[1].id,
    });
    expect(result.price).toBe(132_000);

    const moved = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'incineroar' } },
    });
    expect(moved.teamId).toBe(other.id);
    // It arrives as a reserve: the buying manager picks their own six.
    expect(moved.starter).toBe(false);
    expect(moved.captain).toBe(false);

    const after = {
      seller: (await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash,
      buyer: (await db.team.findUniqueOrThrow({ where: { id: other.id } })).cash,
    };
    expect(after.seller).toBe(before.seller + 132_000);
    expect(after.buyer).toBe(before.buyer - 132_000);
    expect(await verifyLedger(db, league.id)).toEqual([]);

    // And it is off the board.
    expect(await openListings(league.id)).toHaveLength(0);
  });

  it('lets only one of two clubs racing for it win', async () => {
    const { league, team, other, extras, users } = await makeLeague(1);
    const third = extras[0];

    const listing = await list(league.id, team.id, 'garchomp', 50_000);
    const results = await Promise.allSettled([
      buyListing({ listingId: listing.id, teamId: other.id, actorUserId: users[1].id }),
      buyListing({ listingId: listing.id, teamId: third.id }),
    ]);

    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const owner = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'garchomp' } },
    });
    expect([other.id, third.id]).toContain(owner.teamId);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('refuses a club that cannot pay, and leaves the listing up', async () => {
    const { league, team, other } = await makeLeague();
    // Drained through the ledger, not by writing the cached balance: `Team.cash` is a cache and
    // `verifyLedger` would rightly call a direct edit a hole in the books.
    const rich = await db.team.findUniqueOrThrow({ where: { id: other.id } });
    await db.$transaction((tx) =>
      postEntry(tx, {
        leagueId: league.id,
        teamId: other.id,
        type: 'ADJUSTMENT',
        amount: -(rich.cash - 10),
        description: 'Spent on nothing in particular',
      }),
    );

    const listing = await list(league.id, team.id, 'garchomp', 50_000);
    await expect(buyListing({ listingId: listing.id, teamId: other.id })).rejects.toThrow();

    expect(await openListings(league.id)).toHaveLength(1);
    const still = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'garchomp' } },
    });
    expect(still.teamId).toBe(team.id);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('will not let the club that listed it change its mind', async () => {
    const { league, team, users } = await makeLeague();
    const listing = await list(league.id, team.id, 'garchomp', 50_000);

    await expect(
      withdrawListing({ listingId: listing.id, teamId: team.id, actorUserId: users[0].id }),
    ).rejects.toThrow(ListingError);
    expect(await openListings(league.id)).toHaveLength(1);

    // Nor may a club buy its own, which would be a free way to take one back down.
    await expect(buyListing({ listingId: listing.id, teamId: team.id })).rejects.toThrow(
      /your own listing/i,
    );
  });

  it('stays up for the minimum, then expires and says nobody came', async () => {
    const { league, team } = await makeLeague();
    const listing = await list(league.id, team.id, 'garchomp', 50_000);

    const days = (listing.openUntil.getTime() - listing.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(LISTING_MIN_DAYS);

    // Nothing has expired while it is still running.
    await db.$transaction((tx) => expireListings(tx, { leagueId: league.id, round: 1 }));
    expect(await openListings(league.id)).toHaveLength(1);

    // A week later, it comes off on its own.
    const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.$transaction((tx) => expireListings(tx, { leagueId: league.id, round: 1, now: later }));
    expect(await openListings(league.id)).toHaveLength(0);

    const notice = await db.leagueEvent.findFirstOrThrow({
      where: { leagueId: league.id, templateKey: 'listing:expired' },
    });
    expect(notice.description).toContain('Nobody met the asking price');

    // And it never left the club that put it up.
    const still = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'garchomp' } },
    });
    expect(still.teamId).toBe(team.id);
  });

  it('refuses a second listing for the same Pokémon', async () => {
    const { league, team } = await makeLeague();
    await list(league.id, team.id, 'garchomp', 50_000);
    await expect(list(league.id, team.id, 'garchomp', 40_000)).rejects.toThrow(/already on the market/);
  });
});
