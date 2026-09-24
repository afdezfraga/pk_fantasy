/**
 * The season's shape: who captains a club, how a rank moves and pays, when a round closes by
 * itself, and what a new season takes away.
 *
 * Against a real SQLite database, like the ownership tests, because most of these are about
 * what several writes leave behind together.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buyValue, type LeagueConfig } from '../../config/economy.ts';
import { PAYOUTS } from '../../config/scoring.ts';
import { LADDER, SEASON_START, type Standing } from '../ladder.ts';
import { db } from '../db.ts';
import { setCaptain } from './club.ts';
import { activeEffects, addEffect } from './effects.ts';
import { finishDraft, getDraftState, makePick, startDraft } from './draft.ts';
import { LadderError, standingOf, updateStanding } from './ladder.ts';
import { createLeague, joinLeague } from './league.ts';
import { getLineup } from './lineup.ts';
import { deleteMatch, reportMatch, reportMatchAndDraw } from './matches.ts';
import { verifyLedger } from './money.ts';
import { acquireFreeAgent, sellToMarket } from './ownership.ts';
import { advanceSeason, SeasonError } from './seasons.ts';
import { proposeTrade, respondToTrade } from './trades.ts';

let counter = 0;

/** A fresh league, isolated from every other test. Events off unless a test wants them. */
async function makeLeague(teamCount = 1, config: Partial<LeagueConfig> = {}) {
  counter += 1;
  const users = await Promise.all(
    Array.from({ length: teamCount }, (_, index) =>
      db.user.create({
        data: { username: `season-${counter}-${index}`, displayName: `P${index}`, passwordHash: 'x' },
      }),
    ),
  );
  const { league, team } = await createLeague({
    name: `Season league ${counter}`,
    commissionerId: users[0].id,
    teamName: 'Team 0',
    config: { eventsEnabled: 0, ...config },
  });
  const teams = [team];
  for (let index = 1; index < teamCount; index += 1) {
    const joined = await joinLeague({
      inviteCode: league.inviteCode,
      userId: users[index].id,
      teamName: `Team ${index}`,
    });
    teams.push(joined.team);
  }
  return { league, teams, users };
}

async function sign(leagueId: string, teamId: string, slug: string) {
  const pokemon = await db.pokemon.findUniqueOrThrow({ where: { slug } });
  return acquireFreeAgent({
    leagueId,
    pokemonSlug: slug,
    teamId,
    price: pokemon.baseValue,
    type: 'MARKET_BUY',
  });
}

/** Drafts nothing and ends the draft, which is the quickest honest way to an ACTIVE league. */
async function activate(leagueId: string, commissionerId: string) {
  await startDraft({ leagueId, actorUserId: commissionerId, rounds: 1 });
  await finishDraft({ leagueId, actorUserId: commissionerId });
}

async function captainOf(leagueId: string, teamId: string) {
  const rows = await db.ownership.findMany({ where: { leagueId, teamId, captain: true } });
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.pokemonSlug ?? null;
}

async function teamRow(teamId: string) {
  return db.team.findUniqueOrThrow({ where: { id: teamId } });
}

const at = (tierKey: string, rank: number | null, progress = 0): Standing => ({
  tierKey,
  rank,
  progress,
  ratingPoints: null,
  globalPlacement: null,
});

async function play(
  leagueId: string,
  teamId: string,
  reportedById: string,
  options: { won?: boolean; slugs?: string[]; standing?: Standing } = {},
) {
  const won = options.won ?? true;
  return reportMatch({
    leagueId,
    homeTeamId: teamId,
    awayTeamId: null,
    opponentName: 'Ranked ladder',
    homeScore: won ? 2 : 0,
    awayScore: won ? 0 : 2,
    lines: (options.slugs ?? ['pikachu']).map((slug) => ({
      pokemonSlug: slug,
      teamId,
      kos: 1,
      fainted: false,
      benched: false,
    })),
    standing: options.standing,
    reportedById,
  });
}

async function promotionTotal(teamId: string) {
  const rows = await db.transaction.findMany({ where: { teamId, type: 'PROMOTION' } });
  return rows.reduce((sum, row) => sum + row.amount, 0);
}

describe('the captain', () => {
  it('is the first Pokémon drafted', async () => {
    const { league, teams, users } = await makeLeague(1);
    await startDraft({ leagueId: league.id, actorUserId: users[0].id, rounds: 2 });
    await makePick({ leagueId: league.id, teamId: teams[0].id, pokemonSlug: 'torkoal', actorUserId: users[0].id });
    await makePick({ leagueId: league.id, teamId: teams[0].id, pokemonSlug: 'pikachu', actorUserId: users[0].id });

    expect(await getDraftState(league.id)).toMatchObject({ isComplete: true });
    expect(await captainOf(league.id, teams[0].id)).toBe('torkoal');
  });

  it('passes to the longest-serving Pokémon when the captain is sold', async () => {
    const { league, teams } = await makeLeague(1);
    for (const slug of ['pikachu', 'ditto', 'furfrou']) await sign(league.id, teams[0].id, slug);
    await setCaptain({ leagueId: league.id, teamId: teams[0].id, pokemonSlug: 'furfrou' });

    await sellToMarket({ leagueId: league.id, pokemonSlug: 'furfrou', teamId: teams[0].id });
    expect(await captainOf(league.id, teams[0].id)).toBe('pikachu');
  });

  it('only goes missing with the last Pokémon, and comes back with the next signing', async () => {
    const { league, teams } = await makeLeague(1, { squadMin: 0 });
    await sign(league.id, teams[0].id, 'pikachu');
    await sellToMarket({ leagueId: league.id, pokemonSlug: 'pikachu', teamId: teams[0].id });
    expect(await captainOf(league.id, teams[0].id)).toBeNull();

    await sign(league.id, teams[0].id, 'ditto');
    expect(await captainOf(league.id, teams[0].id)).toBe('ditto');
  });

  it('is replaced on both sides when a trade moves one', async () => {
    const { league, teams, users } = await makeLeague(2);
    await sign(league.id, teams[0].id, 'pikachu');
    await sign(league.id, teams[0].id, 'ditto');
    await sign(league.id, teams[1].id, 'furfrou');

    const offer = await proposeTrade({
      leagueId: league.id,
      fromTeamId: teams[0].id,
      toTeamId: teams[1].id,
      givePokemon: ['pikachu'],
      getPokemon: ['furfrou'],
      cash: 0,
      actorUserId: users[0].id,
    });
    await respondToTrade({ offerId: offer.id, accept: true, actorUserId: users[1].id, teamId: teams[1].id });

    expect(await captainOf(league.id, teams[0].id)).toBe('ditto');
    expect(await captainOf(league.id, teams[1].id)).toBe('pikachu');
  });

  it('is filled in for a squad from before captains were automatic', async () => {
    const { league, teams } = await makeLeague(1);
    await sign(league.id, teams[0].id, 'pikachu');
    await db.ownership.updateMany({ where: { leagueId: league.id }, data: { captain: false } });

    await getLineup(league.id, teams[0].id);
    expect(await captainOf(league.id, teams[0].id)).toBe('pikachu');
  });
});

describe('the ladder rank', () => {
  let league: Awaited<ReturnType<typeof makeLeague>>['league'];
  let teamId: string;
  let userId: string;

  beforeEach(async () => {
    const made = await makeLeague(1);
    league = made.league;
    teamId = made.teams[0].id;
    userId = made.users[0].id;
    await sign(league.id, teamId, 'pikachu');
  });

  it('starts at Poké Ball 4', async () => {
    expect(standingOf(await teamRow(teamId))).toEqual(SEASON_START);
  });

  it('moves with a reported match, and pays for a new tier once a season', async () => {
    await updateStanding({ leagueId: league.id, teamId, actorUserId: userId, standing: at('poke', 1, 2) });
    await play(league.id, teamId, userId, { standing: at('great', 4) });

    expect(standingOf(await teamRow(teamId))).toEqual(at('great', 4));
    expect(await promotionTotal(teamId)).toBe(LADDER.promotionBonus.great);

    // Corrected back down, then climbed again: Great Ball was already reached this season.
    await updateStanding({ leagueId: league.id, teamId, actorUserId: userId, standing: at('poke', 1, 2) });
    await play(league.id, teamId, userId, { standing: at('great', 4) });
    expect(await promotionTotal(teamId)).toBe(LADDER.promotionBonus.great);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('pays nothing for climbing inside a tier', async () => {
    await play(league.id, teamId, userId, { standing: at('poke', 3) });
    expect(await promotionTotal(teamId)).toBe(0);
  });

  it('never pays for a hand correction', async () => {
    await updateStanding({ leagueId: league.id, teamId, actorUserId: userId, standing: at('ultra', 4) });
    expect(standingOf(await teamRow(teamId))).toEqual(at('ultra', 4));
    expect(await promotionTotal(teamId)).toBe(0);
  });

  it('refuses a match that skips a tier, drops one, or promotes on a loss', async () => {
    await expect(play(league.id, teamId, userId, { standing: at('ultra', 4) })).rejects.toThrow(LadderError);

    await updateStanding({ leagueId: league.id, teamId, actorUserId: userId, standing: at('poke', 1, 2) });
    await expect(
      play(league.id, teamId, userId, { won: false, standing: at('great', 4) }),
    ).rejects.toThrow(LadderError);

    await updateStanding({ leagueId: league.id, teamId, actorUserId: userId, standing: at('great', 4) });
    await expect(
      play(league.id, teamId, userId, { won: false, standing: at('poke', 1) }),
    ).rejects.toThrow(LadderError);

    // Nothing was recorded by the refused reports.
    expect(await db.match.count({ where: { leagueId: league.id } })).toBe(0);
  });

  it('counts every Pokémon on a losing side as fainted', async () => {
    await sign(league.id, teamId, 'ditto');
    const { match } = await play(league.id, teamId, userId, { won: false, slugs: ['pikachu', 'ditto'] });
    const stats = await db.matchPokemonStat.findMany({ where: { matchId: match.id } });
    expect(stats.map((stat) => stat.fainted)).toEqual([true, true]);
  });

  it('goes back, bonus and all, when the match that moved it is deleted', async () => {
    await updateStanding({ leagueId: league.id, teamId, actorUserId: userId, standing: at('poke', 1, 2) });
    const { match } = await play(league.id, teamId, userId, { standing: at('great', 4) });
    await deleteMatch({ matchId: match.id, actorUserId: userId });

    expect(standingOf(await teamRow(teamId))).toEqual(at('poke', 1, 2));
    expect(await promotionTotal(teamId)).toBe(0);
    expect(await db.rankEvent.count({ where: { teamId, toLabel: 'Great Ball 4' } })).toBe(0);

    // The season peak went back with it, so the real climb still pays.
    await play(league.id, teamId, userId, { standing: at('great', 4) });
    expect(await promotionTotal(teamId)).toBe(LADDER.promotionBonus.great);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('stays put when a later report has moved on from the deleted match', async () => {
    const first = await play(league.id, teamId, userId, { standing: at('poke', 4, 1) });
    await play(league.id, teamId, userId, { standing: at('poke', 4, 2) });
    await deleteMatch({ matchId: first.match.id, actorUserId: userId });

    expect(standingOf(await teamRow(teamId))).toEqual(at('poke', 4, 2));
  });
});

describe('a round', () => {
  async function playOut(leagueId: string, teamId: string, userId: string, slug: string, count: number) {
    let last: Awaited<ReturnType<typeof reportMatchAndDraw>> | null = null;
    for (let index = 0; index < count; index += 1) {
      last = await reportMatchAndDraw({
        leagueId,
        homeTeamId: teamId,
        awayTeamId: null,
        opponentName: 'Ranked ladder',
        homeScore: 0,
        awayScore: 1,
        lines: [{ pokemonSlug: slug, teamId, kos: 0, fainted: true, benched: false }],
        reportedById: userId,
      });
    }
    return last!;
  }

  it('closes by itself once half the clubs have played every paid match', async () => {
    const { league, teams, users } = await makeLeague(2);
    await sign(league.id, teams[0].id, 'pikachu');
    await sign(league.id, teams[1].id, 'ditto');
    await activate(league.id, users[0].id);

    const almost = await playOut(league.id, teams[0].id, users[0].id, 'pikachu', PAYOUTS.paidMatchesPerRound - 1);
    expect(almost.closedRound).toBeNull();
    expect((await db.league.findUniqueOrThrow({ where: { id: league.id } })).round).toBe(1);

    const last = await playOut(league.id, teams[0].id, users[0].id, 'pikachu', 1);
    expect(last.closedRound).toBe(1);
    expect((await db.league.findUniqueOrThrow({ where: { id: league.id } })).round).toBe(2);
  });

  it('waits for half, rounded up', async () => {
    const { league, teams, users } = await makeLeague(3);
    for (const [index, slug] of ['pikachu', 'ditto', 'furfrou'].entries()) {
      await sign(league.id, teams[index].id, slug);
    }
    await activate(league.id, users[0].id);

    await playOut(league.id, teams[0].id, users[0].id, 'pikachu', PAYOUTS.paidMatchesPerRound);
    expect((await db.league.findUniqueOrThrow({ where: { id: league.id } })).round).toBe(1);

    await playOut(league.id, teams[1].id, users[1].id, 'ditto', PAYOUTS.paidMatchesPerRound);
    expect((await db.league.findUniqueOrThrow({ where: { id: league.id } })).round).toBe(2);
  });
});

describe('a new season', () => {
  it('resets every rank and sells everything but the captain', async () => {
    const { league, teams, users } = await makeLeague(2);
    for (const slug of ['pikachu', 'ditto', 'furfrou']) await sign(league.id, teams[0].id, slug);
    await sign(league.id, teams[1].id, 'delibird');
    await activate(league.id, users[0].id);
    await updateStanding({ leagueId: league.id, teamId: teams[0].id, actorUserId: users[0].id, standing: at('ultra', 2, 3) });

    const cashBefore = (await teamRow(teams[0].id)).cash;
    const result = await advanceSeason({ leagueId: league.id, actorUserId: users[0].id });
    expect(result).toMatchObject({ season: 1, next: 2, sold: 2 });

    const squad = await db.ownership.findMany({ where: { leagueId: league.id, teamId: teams[0].id } });
    expect(squad.map((row) => row.pokemonSlug)).toEqual(['pikachu']);
    expect(squad[0]).toMatchObject({ captain: true, starter: true });
    expect((await teamRow(teams[0].id)).cash).toBe(cashBefore + buyValue(6_000) + buyValue(8_000));
    expect(await captainOf(league.id, teams[1].id)).toBe('delibird');

    for (const team of teams) {
      expect(standingOf(await teamRow(team.id))).toEqual(SEASON_START);
    }

    const after = await db.league.findUniqueOrThrow({ where: { id: league.id }, include: { draft: true } });
    expect(after).toMatchObject({ season: 2, round: 2, status: 'SETUP', draft: null });
    expect(await db.ownership.count({ where: { leagueId: league.id, status: 'WAIVERS' } })).toBe(0);
    expect(await verifyLedger(db, league.id)).toEqual([]);

    // Ready for the new draft.
    await expect(startDraft({ leagueId: league.id, actorUserId: users[0].id })).resolves.toBeTruthy();
  });

  it('pays a tier bonus again in the new season', async () => {
    const { league, teams, users } = await makeLeague(1);
    await sign(league.id, teams[0].id, 'pikachu');
    await activate(league.id, users[0].id);
    await updateStanding({ leagueId: league.id, teamId: teams[0].id, actorUserId: users[0].id, standing: at('poke', 1, 2) });
    await play(league.id, teams[0].id, users[0].id, { standing: at('great', 4) });

    await advanceSeason({ leagueId: league.id, actorUserId: users[0].id });
    await activate(league.id, users[0].id);
    await updateStanding({ leagueId: league.id, teamId: teams[0].id, actorUserId: users[0].id, standing: at('poke', 1, 2) });
    await play(league.id, teams[0].id, users[0].id, { standing: at('great', 4) });

    expect(await promotionTotal(teams[0].id)).toBe(2 * LADDER.promotionBonus.great);
  });

  it('calls off trades that were waiting', async () => {
    const { league, teams, users } = await makeLeague(2);
    await sign(league.id, teams[0].id, 'pikachu');
    await sign(league.id, teams[0].id, 'ditto');
    await sign(league.id, teams[1].id, 'furfrou');
    await activate(league.id, users[0].id);
    const offer = await proposeTrade({
      leagueId: league.id,
      fromTeamId: teams[0].id,
      toTeamId: teams[1].id,
      givePokemon: ['ditto'],
      getPokemon: [],
      cash: 0,
      actorUserId: users[0].id,
    });

    await advanceSeason({ leagueId: league.id, actorUserId: users[0].id });
    expect((await db.tradeOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('CANCELLED');
  });

  it('tears up everything in force, and hands back what was locked', async () => {
    // A restriction outlives the thing it was about. The squad it applied to has just been sold,
    // so a rule about a Pokémon another club now owns would block reports for ever.
    const { league, teams, users } = await makeLeague(2);
    await sign(league.id, teams[0].id, 'pikachu');
    await sign(league.id, teams[0].id, 'ditto');
    await sign(league.id, teams[1].id, 'furfrou');
    await activate(league.id, users[0].id);

    const before = (await teamRow(teams[0].id)).cash;
    await db.$transaction(async (tx) => {
      await addEffect(tx, {
        leagueId: league.id,
        teamId: teams[0].id,
        kind: 'MUST_FIELD',
        pokemonSlug: 'ditto',
        matches: 5,
        label: 'Ditto must play',
        liftedMessage: 'x',
      });
      await addEffect(tx, {
        leagueId: league.id,
        teamId: teams[0].id,
        kind: 'ESCROW',
        params: { amount: 20_000, returnPct: 120 },
        untilRound: 3,
        label: 'League bond',
        liftedMessage: 'y',
      });
    });

    const result = await advanceSeason({ leagueId: league.id, actorUserId: users[0].id });

    expect(await activeEffects(league.id, teams[0].id)).toEqual([]);
    expect(result.cleared).toBe(2);
    // The stake comes back at face value: the interest was for seeing the term out. The squad
    // being sold off lands in the same balance, so the stake is checked on its own entry.
    expect(result.refunded).toBe(20_000);
    const returned = await db.transaction.findMany({
      where: { teamId: teams[0].id, description: { contains: 'season over' } },
    });
    expect(returned.map((row) => row.amount)).toEqual([20_000]);
    expect((await teamRow(teams[0].id)).cash).toBe(before + result.proceeds + 20_000);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('calls a running wager off as a push rather than charging for it', async () => {
    const { league, teams, users } = await makeLeague(2);
    await sign(league.id, teams[0].id, 'pikachu');
    await sign(league.id, teams[1].id, 'furfrou');
    await activate(league.id, users[0].id);

    const before = (await teamRow(teams[0].id)).cash;
    await db.$transaction(async (tx) => {
      await addEffect(tx, {
        leagueId: league.id,
        teamId: teams[0].id,
        kind: 'PLEDGE',
        params: { wins: 5, outOf: 5, won: 0, reward: 200_000, penalty: 90_000 },
        matches: 5,
        label: 'Sponsor target',
        liftedMessage: 'z',
      });
    });

    await advanceSeason({ leagueId: league.id, actorUserId: users[0].id });

    // Neither paid nor charged: the club never got the matches the target was set over.
    expect((await teamRow(teams[0].id)).cash).toBe(before);
    const notice = await db.leagueEvent.findFirstOrThrow({
      where: { leagueId: league.id, teamId: teams[0].id, templateKey: 'lifted:pledge' },
    });
    expect(notice.title).toBe('Target called off');
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('is the commissioner’s call, and only once the draft is done', async () => {
    const { league, users } = await makeLeague(2);
    await expect(advanceSeason({ leagueId: league.id, actorUserId: users[0].id })).rejects.toThrow(SeasonError);

    await activate(league.id, users[0].id);
    await expect(advanceSeason({ leagueId: league.id, actorUserId: users[1].id })).rejects.toThrow(SeasonError);
  });
});
