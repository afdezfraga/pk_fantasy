/**
 * The event board against a real database: the parts worth testing are the ones that race or
 * move money — one board per close however many page loads arrive, one bid per club, and the
 * winner paid exactly what it asked and dealt exactly what it read.
 */

import { describe, expect, it } from 'vitest';

import { type LeagueConfig } from '../../config/economy.ts';
import { db } from '../db.ts';
import { getBoard, namedPokemon, placeBid, recentResults, refreshOffers, sweepBoard } from './board.ts';
import { EventPendingError, pendingEvent } from './events.ts';
import { createLeague, joinLeague, updateBoardSettings } from './league.ts';
import { reportMatch } from './matches.ts';
import { verifyLedger } from './money.ts';
import { acquireFreeAgent, sellToMarket } from './ownership.ts';
import { advanceSeason } from './seasons.ts';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-01T20:00:00Z');
const after = (hours: number) => new Date(T0.getTime() + hours * HOUR);

let counter = 0;

async function sign(leagueId: string, teamId: string, slugs: string[]) {
  for (const slug of slugs) {
    const row = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId, pokemonSlug: slug } },
    });
    await acquireFreeAgent({ leagueId, pokemonSlug: slug, teamId, price: row.marketValue, type: 'DRAFT_PICK' });
  }
}

/**
 * Two clubs with squads of their own, drafted and playing. Unless a test sets its own size, the
 * board is as big as the deck, so a test can pick the event it wants off it rather than hoping
 * the roll put it up.
 */
async function makeLeague(config: Partial<LeagueConfig> = {}) {
  counter += 1;
  const users = await Promise.all(
    [0, 1].map((index) =>
      db.user.create({
        data: { username: `board-${counter}-${index}`, displayName: `Player ${index}`, passwordHash: 'x' },
      }),
    ),
  );
  const { league, team } = await createLeague({
    name: `Board ${counter}`,
    commissionerId: users[0].id,
    teamName: 'Cinnabar',
    config: { startingCash: 2_000_000, ...config },
  });
  // A board the size of the deck is past what a commissioner may set, which is the point: it
  // is a test fixture, not a league. Written straight into the stored config.
  if (config.eventBoardSize === undefined) {
    await db.league.update({
      where: { id: league.id },
      data: { config: JSON.stringify({ ...JSON.parse(league.config), eventBoardSize: 40 }) },
    });
  }
  const other = await joinLeague({ inviteCode: league.inviteCode, userId: users[1].id, teamName: 'Viridian' });

  await sign(league.id, team.id, ['incineroar', 'garchomp', 'whimsicott', 'torkoal', 'sableye', 'pikachu']);
  await sign(league.id, other.team.id, ['ditto', 'furfrou', 'delibird', 'luvdisc']);
  await db.league.update({ where: { id: league.id }, data: { status: 'ACTIVE' } });

  return { league, team, other: other.team, users };
}

async function auctionFor(leagueId: string, templateKey: string) {
  return db.eventAuction.findFirstOrThrow({ where: { leagueId, templateKey, status: 'OPEN' } });
}

async function cash(teamId: string) {
  return (await db.team.findUniqueOrThrow({ where: { id: teamId } })).cash;
}

describe('putting a board up', () => {
  it('opens one, with every club’s own version of each event, closing a period out', async () => {
    const { league, team, other } = await makeLeague({ eventBoardSize: 2, eventBoardHours: 24 });
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });

    const auctions = await db.eventAuction.findMany({ where: { leagueId: league.id }, include: { offers: true } });
    expect(auctions).toHaveLength(2);
    expect(new Set(auctions.map((auction) => auction.templateKey)).size).toBe(2);
    for (const auction of auctions) {
      expect(auction.closesAt.getTime()).toBe(after(24).getTime());
      expect(auction.offers.map((offer) => offer.teamId).sort()).toEqual([team.id, other.id].sort());
    }
  });

  it('puts up exactly one board when several page loads arrive together', async () => {
    const { league } = await makeLeague({ eventBoardSize: 2 });
    await Promise.all([0, 1, 2].map(() => sweepBoard(league.id, { now: T0, random: () => 0.5 })));
    expect(await db.eventAuction.count({ where: { leagueId: league.id } })).toBe(2);
  });

  it('leaves the board alone until it closes', async () => {
    const { league } = await makeLeague({ eventBoardSize: 2 });
    await sweepBoard(league.id, { now: T0 });
    await sweepBoard(league.id, { now: after(23) });
    expect(await db.eventAuction.count({ where: { leagueId: league.id } })).toBe(2);
  });

  it('writes the same event against each club’s own squad', async () => {
    const { league, team, other } = await makeLeague();
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });

    const knock = await db.eventAuction.findFirstOrThrow({
      where: { leagueId: league.id, templateKey: 'knock_in_training' },
      include: { offers: true },
    });
    const squads = new Map<string, string[]>([
      [team.id, ['incineroar', 'garchomp', 'whimsicott', 'torkoal', 'sableye', 'pikachu']],
      [other.id, ['ditto', 'furfrou', 'delibird', 'luvdisc']],
    ]);
    for (const offer of knock.offers) {
      const named = namedPokemon(offer);
      expect(named.length).toBeGreaterThan(0);
      for (const slug of named) expect(squads.get(offer.teamId)).toContain(slug);
    }
  });

  it('opens nothing in a league with events switched off', async () => {
    const { league } = await makeLeague({ eventsEnabled: 0 });
    await sweepBoard(league.id, { now: T0 });
    expect(await db.eventAuction.count({ where: { leagueId: league.id } })).toBe(0);
  });
});

describe('bidding', () => {
  it('takes one sealed bid per club, and never a second', async () => {
    const { league, team, other } = await makeLeague();
    await sweepBoard(league.id, { now: T0 });
    const auction = await auctionFor(league.id, 'stadium_works');

    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 20_000, now: after(1) });
    await expect(
      placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 5_000, now: after(2) }),
    ).rejects.toThrow(/final/);

    // The other club sees its own bid slot empty, and nothing of ours.
    const theirs = (await getBoard(league.id, other.id)).find((entry) => entry.id === auction.id)!;
    expect(theirs.myBid).toBeNull();
    const ours = (await getBoard(league.id, team.id)).find((entry) => entry.id === auction.id)!;
    expect(ours.myBid).toBe(20_000);
  });

  it('refuses an ask over the ceiling, below nothing, or after the board has closed', async () => {
    const { league, team } = await makeLeague({ eventBidMax: 50_000 });
    await sweepBoard(league.id, { now: T0 });
    const auction = await auctionFor(league.id, 'stadium_works');
    const at = (amount: number, now = after(1)) =>
      placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount, now });

    await expect(at(50_001)).rejects.toThrow(/₽50,000/);
    await expect(at(-1)).rejects.toThrow(/negative/);
    await expect(at(1.5)).rejects.toThrow(/whole number/);
    await expect(at(10_000, after(24))).rejects.toThrow(/closed/);
    await expect(at(50_000)).resolves.toBeTruthy();
  });

  it('shuts out a club the event’s requirements do not fit, and says why', async () => {
    const { league, team } = await makeLeague();
    // Suspension wants eight matches played. Put one up by hand, since nobody here qualifies
    // and the draw would rightly never choose it.
    const auction = await db.eventAuction.create({
      data: { leagueId: league.id, templateKey: 'suspension', title: 'Suspension', round: 1, closesAt: after(24) },
    });
    await refreshOffers(league.id, team.id);

    const entry = (await getBoard(league.id, team.id)).find((candidate) => candidate.id === auction.id)!;
    expect(entry.closedReason).toMatch(/matches/);
    await expect(
      placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 0, now: after(1) }),
    ).rejects.toThrow(/matches/);
  });
});

describe('when the board closes', () => {
  it('pays the lowest ask, deals it the event it read, and asks the rest for nothing', async () => {
    const { league, team, other, users } = await makeLeague();
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });
    const auction = await auctionFor(league.id, 'stadium_works');
    const offer = await db.eventOffer.findUniqueOrThrow({
      where: { auctionId_teamId: { auctionId: auction.id, teamId: other.id } },
    });

    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 30_000, now: after(1) });
    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: other.id, amount: 12_000, now: after(2) });

    const before = { ours: await cash(team.id), theirs: await cash(other.id) };
    await sweepBoard(league.id, { now: after(25), random: () => 0.5 });

    const settled = await db.eventAuction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(settled.status).toBe('AWARDED');
    expect(settled.winnerTeamId).toBe(other.id);
    expect(settled.winningBid).toBe(12_000);

    expect(await cash(other.id)).toBe(before.theirs + 12_000);
    expect(await cash(team.id)).toBe(before.ours);

    // It was dealt exactly the version it bid on.
    const event = (await pendingEvent(league.id, other.id))!;
    expect(event.id).toBe(settled.eventId);
    expect(event.description).toBe(offer.description);
    expect(event.choices).toBe(offer.choices);

    // And it now has a decision outstanding, like any other event.
    await expect(
      reportMatch({
        leagueId: league.id,
        homeTeamId: other.id,
        awayTeamId: null,
        opponentName: 'Ranked ladder',
        homeScore: 4,
        awayScore: 0,
        lines: ['ditto', 'furfrou', 'delibird', 'luvdisc'].map((slug) => ({
          pokemonSlug: slug,
          teamId: other.id,
          kos: 1,
          fainted: false,
          benched: false,
        })),
        attested: [],
        reportedById: users[1].id,
      }),
    ).rejects.toThrow(EventPendingError);

    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('announces the winning figure and nothing of the losing bids', async () => {
    const { league, team, other } = await makeLeague();
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });
    const auction = await auctionFor(league.id, 'stadium_works');
    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 31_700, now: after(1) });
    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: other.id, amount: 12_000, now: after(1) });
    await sweepBoard(league.id, { now: after(25), random: () => 0.5 });

    const news = await db.leagueEvent.findFirstOrThrow({
      where: { leagueId: league.id, templateKey: 'board:stadium_works' },
    });
    expect(news.description).toContain('Viridian');
    expect(news.description).toContain('₽12,000');
    expect(news.description).toContain('lowest of 2 bids');
    expect(news.description).not.toContain('31,700');

    const [result] = (await recentResults(league.id)).filter((row) => row.id === auction.id);
    expect(result).toMatchObject({ winner: 'Viridian', amount: 12_000, bids: 2 });
  });

  it('breaks a tie in favour of the club lower down the table', async () => {
    const { league, team, other } = await makeLeague();
    // Same standing, so the table falls back on points: Cinnabar sits above Viridian.
    await db.team.update({ where: { id: team.id }, data: { points: 100 } });
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });
    const auction = await auctionFor(league.id, 'stadium_works');

    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: other.id, amount: 8_000, now: after(1) });
    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 8_000, now: after(2) });
    await sweepBoard(league.id, { now: after(25), random: () => 0.5 });

    expect((await db.eventAuction.findUniqueOrThrow({ where: { id: auction.id } })).winnerTeamId).toBe(other.id);
  });

  it('lets an event nobody wanted go, and moves no money', async () => {
    const { league, team, other } = await makeLeague({ eventBoardSize: 2 });
    await sweepBoard(league.id, { now: T0 });
    const before = [await cash(team.id), await cash(other.id)];

    await sweepBoard(league.id, { now: after(25) });

    const closed = await db.eventAuction.findMany({ where: { leagueId: league.id, closesAt: after(24) } });
    expect(closed.every((auction) => auction.status === 'UNCLAIMED')).toBe(true);
    expect([await cash(team.id), await cash(other.id)]).toEqual(before);
    expect(await db.leagueEvent.count({ where: { leagueId: league.id, status: 'PENDING' } })).toBe(0);
  });

  it('puts the next board up on the same beat', async () => {
    const { league } = await makeLeague({ eventBoardSize: 2, eventBoardHours: 24 });
    await sweepBoard(league.id, { now: T0 });
    await sweepBoard(league.id, { now: after(27) });

    const open = await db.eventAuction.findMany({ where: { leagueId: league.id, status: 'OPEN' } });
    expect(open).toHaveLength(2);
    expect(open.every((auction) => auction.closesAt.getTime() === after(48).getTime())).toBe(true);
  });
});

describe('a Pokémon that leaves before the board closes', () => {
  it('has its event written again against the squad that is left', async () => {
    const { league, team } = await makeLeague();
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });
    const auction = await auctionFor(league.id, 'knock_in_training');
    const where = { auctionId_teamId: { auctionId: auction.id, teamId: team.id } };

    const first = await db.eventOffer.findUniqueOrThrow({ where });
    const subject = JSON.parse(first.detail).subject as string;
    await sellToMarket({ leagueId: league.id, pokemonSlug: subject, teamId: team.id });

    await refreshOffers(league.id, team.id, () => 0.5);
    const second = await db.eventOffer.findUniqueOrThrow({ where });
    expect(namedPokemon(second)).not.toContain(subject);
    expect(second.description).not.toBe(first.description);
  });

  it('is dealt to the winner about a Pokémon it still has, even if it sold one after bidding', async () => {
    const { league, team } = await makeLeague();
    await sweepBoard(league.id, { now: T0, random: () => 0.5 });
    const auction = await auctionFor(league.id, 'knock_in_training');
    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 1_000, now: after(1) });

    const offer = await db.eventOffer.findUniqueOrThrow({
      where: { auctionId_teamId: { auctionId: auction.id, teamId: team.id } },
    });
    const subject = JSON.parse(offer.detail).subject as string;
    await sellToMarket({ leagueId: league.id, pokemonSlug: subject, teamId: team.id });

    await sweepBoard(league.id, { now: after(25), random: () => 0.5 });

    const event = (await pendingEvent(league.id, team.id))!;
    expect(event.templateKey).toBe('knock_in_training');
    const squad = (await db.ownership.findMany({ where: { leagueId: league.id, teamId: team.id } })).map(
      (row) => row.pokemonSlug,
    );
    for (const slug of namedPokemon(event)) expect(squad).toContain(slug);
  });
});

describe('the commissioner’s dials', () => {
  it('are checked at creation and when changed, and a change waits for the next board', async () => {
    await expect(makeLeague({ eventBoardSize: 0 })).rejects.toThrow(/between 1 and 6/);

    const { league, users } = await makeLeague({ eventBoardSize: 2, eventBoardHours: 24 });
    await sweepBoard(league.id, { now: T0 });

    await expect(
      updateBoardSettings({
        leagueId: league.id,
        actorUserId: users[1].id,
        settings: { eventBoardHours: 72, eventBoardSize: 3, eventBidMax: 20_000 },
      }),
    ).rejects.toThrow(/commissioner/);

    const config = await updateBoardSettings({
      leagueId: league.id,
      actorUserId: users[0].id,
      settings: { eventBoardHours: 72, eventBoardSize: 3, eventBidMax: 20_000 },
    });
    // Everything else the league was created with is still there.
    expect(config.startingCash).toBe(2_000_000);

    // The board on show keeps the close it published.
    const open = await db.eventAuction.findMany({ where: { leagueId: league.id, status: 'OPEN' } });
    expect(open).toHaveLength(2);
    expect(open.every((auction) => auction.closesAt.getTime() === after(24).getTime())).toBe(true);

    // The next one is three events, three days out.
    await sweepBoard(league.id, { now: after(25) });
    const next = await db.eventAuction.findMany({ where: { leagueId: league.id, status: 'OPEN' } });
    expect(next).toHaveLength(3);
    expect(next.every((auction) => auction.closesAt.getTime() === after(24 + 72).getTime())).toBe(true);
  });
});

describe('a new season', () => {
  it('sweeps the open board away, bids and all, and pays nobody', async () => {
    const { league, team, users } = await makeLeague();
    await sweepBoard(league.id, { now: T0 });
    const auction = await auctionFor(league.id, 'stadium_works');
    await placeBid({ leagueId: league.id, auctionId: auction.id, teamId: team.id, amount: 1_000, now: after(1) });

    await advanceSeason({ leagueId: league.id, actorUserId: users[0].id });

    expect((await db.eventAuction.findUniqueOrThrow({ where: { id: auction.id } })).status).toBe('CANCELLED');
    expect((await db.league.findUniqueOrThrow({ where: { id: league.id } })).boardUntil).toBeNull();
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });
});
