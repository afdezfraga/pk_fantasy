/**
 * The tests that matter most: exclusive ownership, and a ledger that always balances.
 *
 * These run against a real SQLite database, because the guarantees being tested are database
 * guarantees — a mock would just be testing that I can write a mock.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { applyPct, buyValue, LEAGUE_DEFAULTS, type LeagueConfig } from '../../config/economy.ts';
import { PAYOUTS } from '../../config/scoring.ts';
import { db } from '../db.ts';
import { createLeague, joinLeague } from './league.ts';
import { getLineup, setLineup, setStarter } from './lineup.ts';
import { deleteMatch, MatchError, reportMatch } from './matches.ts';
import { InsufficientFunds, verifyLedger } from './money.ts';
import { acquireFreeAgent, OwnershipConflict, RosterRuleViolation, sellToMarket } from './ownership.ts';
import { advanceRound } from './rounds.ts';

let counter = 0;

/** A fresh league with `teamCount` teams, isolated from every other test. */
async function makeLeague(teamCount = 2, config: Partial<LeagueConfig> = {}) {
  counter += 1;
  const users = await Promise.all(
    Array.from({ length: teamCount }, (_, index) =>
      db.user.create({
        data: {
          username: `user-${counter}-${index}`,
          displayName: `Player ${index}`,
          passwordHash: 'x',
        },
      }),
    ),
  );

  const { league, team } = await createLeague({
    name: `League ${counter}`,
    commissionerId: users[0].id,
    teamName: 'Team 0',
    config,
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

describe('league creation', () => {
  it('creates a free-agent row for every legal Pokémon', async () => {
    const { league } = await makeLeague(1);
    const rows = await db.ownership.findMany({ where: { leagueId: league.id } });
    const catalog = await db.pokemon.count({ where: { legal: true } });

    expect(rows).toHaveLength(catalog);
    expect(rows.every((row) => row.teamId === null && row.status === 'FREE_AGENT')).toBe(true);
  });

  it('starts each team with the configured cash, recorded in the ledger', async () => {
    const { league, teams } = await makeLeague(2);
    expect(teams[0].cash).toBe(LEAGUE_DEFAULTS.startingCash);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('issues an unambiguous invite code', async () => {
    const { league } = await makeLeague(1);
    // No O/0 or I/1: these get read out loud and typed on phones.
    expect(league.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
});

describe('exclusive ownership', () => {
  it('lets exactly one team win a race for the same Pokémon', async () => {
    const { league, teams } = await makeLeague(4);

    // Everyone lunges for Incineroar at the same instant.
    const attempts = await Promise.allSettled(
      teams.map((team) =>
        acquireFreeAgent({
          leagueId: league.id,
          pokemonSlug: 'incineroar',
          teamId: team.id,
          price: 120_000,
          type: 'MARKET_BUY',
        }),
      ),
    );

    const winners = attempts.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);

    const ownership = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, pokemonSlug: 'incineroar' },
    });
    expect(ownership.teamId).not.toBeNull();
    expect(ownership.status).toBe('OWNED');

    // And crucially: only the winner paid.
    const charged = await db.transaction.findMany({
      where: { leagueId: league.id, type: 'MARKET_BUY' },
    });
    expect(charged).toHaveLength(1);
    expect(charged[0].teamId).toBe(ownership.teamId);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('refuses a second buyer once a Pokémon is owned', async () => {
    const { league, teams } = await makeLeague(2);
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'torkoal',
      teamId: teams[0].id,
      price: 70_000,
      type: 'MARKET_BUY',
    });

    await expect(
      acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: 'torkoal',
        teamId: teams[1].id,
        price: 70_000,
        type: 'MARKET_BUY',
      }),
    ).rejects.toBeInstanceOf(OwnershipConflict);
  });

  it('keeps leagues independent — the same Pokémon in two leagues is two different things', async () => {
    const a = await makeLeague(1);
    const b = await makeLeague(1);

    await acquireFreeAgent({
      leagueId: a.league.id,
      pokemonSlug: 'garchomp',
      teamId: a.teams[0].id,
      price: 132_000,
      type: 'MARKET_BUY',
    });

    // Must not throw: exclusivity is per league, not global.
    await expect(
      acquireFreeAgent({
        leagueId: b.league.id,
        pokemonSlug: 'garchomp',
        teamId: b.teams[0].id,
        price: 132_000,
        type: 'MARKET_BUY',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('money', () => {
  it('will not let a team spend money it does not have', async () => {
    const { league, teams } = await makeLeague(1, { startingCash: 50_000 });

    await expect(
      acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: 'garchomp',
        teamId: teams[0].id,
        price: 132_000,
        type: 'MARKET_BUY',
      }),
    ).rejects.toBeInstanceOf(InsufficientFunds);

    // And the failed purchase left nothing behind.
    const ownership = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, pokemonSlug: 'garchomp' },
    });
    expect(ownership.teamId).toBeNull();

    const team = await db.team.findUniqueOrThrow({ where: { id: teams[0].id } });
    expect(team.cash).toBe(50_000);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('keeps cash and ledger in step across a run of transactions', async () => {
    const { league, teams } = await makeLeague(2, { squadMin: 0 });

    for (const slug of ['pikachu', 'ditto', 'furfrou']) {
      await acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: slug,
        teamId: teams[0].id,
        price: 6_000,
        type: 'MARKET_BUY',
      });
    }
    await sellToMarket({ leagueId: league.id, pokemonSlug: 'ditto', teamId: teams[0].id });

    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('rejects fractional money before it can corrupt the ledger', async () => {
    const { league, teams } = await makeLeague(1);
    await expect(
      acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: 'pikachu',
        teamId: teams[0].id,
        price: 6_000.5,
        type: 'MARKET_BUY',
      }),
    ).rejects.toThrow(/whole Pok/);
  });
});

describe('roster rules', () => {
  it('has no salary cap — only cash limits what a squad costs', async () => {
    const { league, teams } = await makeLeague(1, { startingCash: 1_000_000 });
    for (const [slug, price] of [
      ['incineroar', 300_000],
      ['garchomp', 400_000],
      ['whimsicott', 300_000],
    ] as const) {
      await acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: slug,
        teamId: teams[0].id,
        price,
        type: 'MARKET_BUY',
      });
    }
    const team = await db.team.findUniqueOrThrow({ where: { id: teams[0].id } });
    expect(team.cash).toBe(0);
  });

  it('enforces the squad maximum', async () => {
    const { league, teams } = await makeLeague(1, { squadMax: 2 });

    for (const slug of ['pikachu', 'ditto']) {
      await acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: slug,
        teamId: teams[0].id,
        price: 6_000,
        type: 'MARKET_BUY',
      });
    }

    await expect(
      acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: 'furfrou',
        teamId: teams[0].id,
        price: 8_000,
        type: 'MARKET_BUY',
      }),
    ).rejects.toBeInstanceOf(RosterRuleViolation);
  });

  it('stops a team selling below the squad minimum', async () => {
    const { league, teams } = await makeLeague(1, { squadMin: 1 });
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'pikachu',
      teamId: teams[0].id,
      price: 6_000,
      type: 'MARKET_BUY',
    });

    await expect(
      sellToMarket({ leagueId: league.id, pokemonSlug: 'pikachu', teamId: teams[0].id }),
    ).rejects.toBeInstanceOf(RosterRuleViolation);
  });
});

describe('value', () => {
  it('drops a signing to 45% of its price the moment it is bought', async () => {
    const { league, teams } = await makeLeague(1);
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'torkoal',
      teamId: teams[0].id,
      price: 70_000,
      type: 'MARKET_BUY',
    });

    const ownership = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, pokemonSlug: 'torkoal' },
    });
    expect(ownership.acquiredPrice).toBe(70_000);
    expect(ownership.marketValue).toBe(buyValue(70_000));
    expect(ownership.marketValue).toBe(31_500);

    const trail = await db.valueChange.findMany({
      where: { leagueId: league.id, pokemonSlug: 'torkoal' },
    });
    expect(trail).toMatchObject([{ reason: 'BUY', delta: -38_500, valueAfter: 31_500 }]);
  });
});

describe('selling', () => {
  it('pays the current value and puts the Pokémon back on the shelf at its shop price', async () => {
    const { league, teams } = await makeLeague(1, { squadMin: 0 });

    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'torkoal',
      teamId: teams[0].id,
      price: 70_000,
      type: 'MARKET_BUY',
    });

    const { proceeds } = await sellToMarket({
      leagueId: league.id,
      pokemonSlug: 'torkoal',
      teamId: teams[0].id,
    });

    // Signing and flipping straight away loses the 55% that vanished at signing.
    expect(proceeds).toBe(buyValue(70_000));

    const ownership = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, pokemonSlug: 'torkoal' },
    });
    expect(ownership.teamId).toBeNull();
    expect(ownership.status).toBe('WAIVERS');
    expect(ownership.marketValue).toBe(70_000);
    expect(ownership.slot).toBeNull();

    const team = await db.team.findUniqueOrThrow({ where: { id: teams[0].id } });
    expect(team.cash).toBe(LEAGUE_DEFAULTS.startingCash - 70_000 + buyValue(70_000));
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('refuses to sell a Pokémon you do not own', async () => {
    const { league, teams } = await makeLeague(2, { squadMin: 0 });
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'sableye',
      teamId: teams[0].id,
      price: 88_000,
      type: 'MARKET_BUY',
    });

    await expect(
      sellToMarket({ leagueId: league.id, pokemonSlug: 'sableye', teamId: teams[1].id }),
    ).rejects.toBeInstanceOf(OwnershipConflict);
  });
});

describe('the starting lineup', () => {
  /** Signs `count` cheap Pokémon so a squad can be built without running out of cash. */
  async function signMany(leagueId: string, teamId: string, slugs: string[]) {
    for (const slug of slugs) {
      await acquireFreeAgent({
        leagueId,
        pokemonSlug: slug,
        teamId,
        price: 6_000,
        type: 'MARKET_BUY',
      });
    }
  }

  // Eight of the fixture catalog, signed at a flat price so cash never gets in the way.
  const CHEAP = [
    'garchomp',
    'incineroar',
    'whimsicott',
    'sableye',
    'torkoal',
    'furfrou',
    'pikachu',
    'ditto',
  ];

  it('starts a signing while there is room, and benches the rest', async () => {
    const { league, teams } = await makeLeague(1, { squadMax: 12 });
    await signMany(league.id, teams[0].id, CHEAP.slice(0, 8));

    const squad = await db.ownership.findMany({
      where: { leagueId: league.id, teamId: teams[0].id },
      orderBy: { acquiredAt: 'asc' },
    });

    // The first six walk into the lineup so a freshly drafted team can report immediately;
    // the seventh and eighth are reserves.
    expect(squad.filter((row) => row.starter)).toHaveLength(LEAGUE_DEFAULTS.lineupSize);
    expect(squad.slice(0, LEAGUE_DEFAULTS.lineupSize).every((row) => row.starter)).toBe(true);
    expect(squad.slice(LEAGUE_DEFAULTS.lineupSize).every((row) => !row.starter)).toBe(true);
  });

  it('frees the slot when a starter is sold', async () => {
    const { league, teams } = await makeLeague(1, { squadMin: 0 });
    await signMany(league.id, teams[0].id, CHEAP.slice(0, 6));

    await sellToMarket({ leagueId: league.id, pokemonSlug: CHEAP[0], teamId: teams[0].id });

    // A sold Pokémon holding a lineup slot would leave a six that can never be filled.
    const starters = await db.ownership.count({
      where: { leagueId: league.id, teamId: teams[0].id, starter: true },
    });
    expect(starters).toBe(5);

    const sold = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, pokemonSlug: CHEAP[0] },
    });
    expect(sold.starter).toBe(false);
  });

  it('refuses a starter beyond the lineup size', async () => {
    const { league, teams } = await makeLeague(1, { squadMax: 12 });
    await signMany(league.id, teams[0].id, CHEAP.slice(0, 7));

    await expect(
      setStarter({
        leagueId: league.id,
        teamId: teams[0].id,
        pokemonSlug: CHEAP[6],
        starter: true,
      }),
    ).rejects.toBeInstanceOf(RosterRuleViolation);
  });

  it('swaps a reserve in once a starter is benched', async () => {
    const { league, teams } = await makeLeague(1, { squadMax: 12 });
    await signMany(league.id, teams[0].id, CHEAP.slice(0, 7));

    await setStarter({
      leagueId: league.id,
      teamId: teams[0].id,
      pokemonSlug: CHEAP[0],
      starter: false,
    });
    await setStarter({
      leagueId: league.id,
      teamId: teams[0].id,
      pokemonSlug: CHEAP[6],
      starter: true,
    });

    const { starters, reserves } = await getLineup(league.id, teams[0].id);
    expect(starters.map((row) => row.pokemonSlug)).toContain(CHEAP[6]);
    expect(reserves.map((row) => row.pokemonSlug)).toContain(CHEAP[0]);
    expect(starters).toHaveLength(LEAGUE_DEFAULTS.lineupSize);
  });

  it('refuses to start a Pokémon on someone else’s squad', async () => {
    const { league, teams } = await makeLeague(2);
    await signMany(league.id, teams[0].id, [CHEAP[0]]);

    await expect(
      setStarter({
        leagueId: league.id,
        teamId: teams[1].id,
        pokemonSlug: CHEAP[0],
        starter: true,
      }),
    ).rejects.toBeInstanceOf(RosterRuleViolation);
  });

  it('gives a lineup to a squad that has none, so the rule is never a dead end', async () => {
    const { league, teams } = await makeLeague(1, { squadMax: 12 });
    await signMany(league.id, teams[0].id, CHEAP.slice(0, 8));

    // A league that predates the lineup feature looks exactly like this.
    await db.ownership.updateMany({
      where: { leagueId: league.id, teamId: teams[0].id },
      data: { starter: false },
    });

    const { starters } = await getLineup(league.id, teams[0].id);
    expect(starters).toHaveLength(LEAGUE_DEFAULTS.lineupSize);
    // The most valuable, since that's the lineup a manager would have picked anyway.
    const values = starters.map((row) => row.marketValue);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  describe('the drag-and-drop board', () => {
    it('saves the whole arrangement: who starts, who sits, and the order', async () => {
      const { league, teams } = await makeLeague(1, { squadMax: 12 });
      await signMany(league.id, teams[0].id, CHEAP.slice(0, 8));

      const starters = [CHEAP[7], CHEAP[6], CHEAP[0], CHEAP[1], CHEAP[2], CHEAP[3]];
      const reserves = [CHEAP[4], CHEAP[5]];
      await setLineup({ leagueId: league.id, teamId: teams[0].id, starters, reserves });

      const lineup = await getLineup(league.id, teams[0].id);
      expect(lineup.starters.map((row) => row.pokemonSlug)).toEqual(starters);
      expect(lineup.reserves.map((row) => row.pokemonSlug)).toEqual(reserves);
      // Shirt numbers run across the whole squad.
      expect(lineup.starters[0].slot).toBe(1);
      expect(lineup.reserves[0].slot).toBe(7);
    });

    it('refuses a seventh starter', async () => {
      const { league, teams } = await makeLeague(1, { squadMax: 12 });
      await signMany(league.id, teams[0].id, CHEAP.slice(0, 8));

      await expect(
        setLineup({
          leagueId: league.id,
          teamId: teams[0].id,
          starters: CHEAP.slice(0, 7),
          reserves: CHEAP.slice(7, 8),
        }),
      ).rejects.toBeInstanceOf(RosterRuleViolation);
    });

    // A board rendered before a signing would post a squad that is missing someone; taking it at
    // face value would silently drop the new Pokémon out of the arrangement.
    it('refuses an arrangement that is not exactly the squad', async () => {
      const { league, teams } = await makeLeague(2, { squadMax: 12 });
      await signMany(league.id, teams[0].id, CHEAP.slice(0, 4));
      await signMany(league.id, teams[1].id, [CHEAP[7]]);

      const cases = [
        { starters: CHEAP.slice(0, 3), reserves: [] },
        { starters: CHEAP.slice(0, 4), reserves: [CHEAP[7]] },
        { starters: [CHEAP[0], CHEAP[0], CHEAP[1], CHEAP[2]], reserves: [CHEAP[3]] },
      ];
      for (const posted of cases) {
        await expect(
          setLineup({ leagueId: league.id, teamId: teams[0].id, ...posted }),
        ).rejects.toBeInstanceOf(RosterRuleViolation);
      }

      // And nothing moved.
      const lineup = await getLineup(league.id, teams[0].id);
      expect(lineup.starters).toHaveLength(4);
    });
  });

  it('leaves a deliberately short lineup alone', async () => {
    const { league, teams } = await makeLeague(1, { squadMax: 12 });
    await signMany(league.id, teams[0].id, CHEAP.slice(0, 8));

    for (const slug of CHEAP.slice(0, 3)) {
      await setStarter({ leagueId: league.id, teamId: teams[0].id, pokemonSlug: slug, starter: false });
    }

    // Refilling here would silently undo a manager's choice.
    const { starters } = await getLineup(league.id, teams[0].id);
    expect(starters).toHaveLength(3);
  });
});

describe('reporting a match', () => {
  it('refuses a Pokémon that is not in the starting lineup', async () => {
    const { league, teams, users } = await makeLeague(1, { squadMax: 12 });
    for (const slug of [
      'garchomp',
      'incineroar',
      'whimsicott',
      'sableye',
      'torkoal',
      'furfrou',
      'pikachu',
    ]) {
      await acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: slug,
        teamId: teams[0].id,
        price: 6_000,
        type: 'MARKET_BUY',
      });
    }
    await db.league.update({ where: { id: league.id }, data: { status: 'ACTIVE' } });

    // The seventh signing is a reserve — the form can't offer it, but a stale page could post it.
    await expect(
      reportMatch({
        leagueId: league.id,
        homeTeamId: teams[0].id,
        awayTeamId: null,
        opponentName: 'Ranked ladder',
        homeScore: 2,
        awayScore: 0,
        lines: [{ pokemonSlug: 'pikachu', teamId: teams[0].id, kos: 2, fainted: false, benched: false }],
        reportedById: users[0].id,
      }),
    ).rejects.toBeInstanceOf(MatchError);
  });

  it('accepts a starter and pays for it', async () => {
    const { league, teams, users } = await makeLeague(1);
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'garchomp',
      teamId: teams[0].id,
      price: 6_000,
      type: 'MARKET_BUY',
    });
    await db.league.update({ where: { id: league.id }, data: { status: 'ACTIVE' } });

    const before = await db.team.findUniqueOrThrow({ where: { id: teams[0].id } });
    await reportMatch({
      leagueId: league.id,
      homeTeamId: teams[0].id,
      awayTeamId: null,
      opponentName: 'Ranked ladder',
      homeScore: 2,
      awayScore: 0,
      lines: [{ pokemonSlug: 'garchomp', teamId: teams[0].id, kos: 2, fainted: false, benched: false }],
      reportedById: users[0].id,
    });

    const after = await db.team.findUniqueOrThrow({ where: { id: teams[0].id } });
    expect(after.cash).toBeGreaterThan(before.cash);
    expect(after.wins).toBe(1);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  describe('rewards and values', () => {
    /** A league with one team fielding Garchomp and Torkoal, in the given ladder tier. */
    async function ready(tierKey: string) {
      const made = await makeLeague(1);
      for (const [slug, price] of [
        ['garchomp', 100_000],
        ['torkoal', 50_000],
      ] as const) {
        await acquireFreeAgent({
          leagueId: made.league.id,
          pokemonSlug: slug,
          teamId: made.teams[0].id,
          price,
          type: 'MARKET_BUY',
        });
      }
      await db.league.update({ where: { id: made.league.id }, data: { status: 'ACTIVE' } });
      await db.team.update({ where: { id: made.teams[0].id }, data: { tierKey } });
      return made;
    }

    function play(made: Awaited<ReturnType<typeof ready>>, won: boolean, benchTorkoal = false) {
      return reportMatch({
        leagueId: made.league.id,
        homeTeamId: made.teams[0].id,
        awayTeamId: null,
        opponentName: 'Ranked ladder',
        homeScore: won ? 2 : 0,
        awayScore: won ? 0 : 2,
        lines: [
          { pokemonSlug: 'garchomp', teamId: made.teams[0].id, kos: 1, fainted: !won, benched: false },
          { pokemonSlug: 'torkoal', teamId: made.teams[0].id, kos: 0, fainted: false, benched: benchTorkoal },
        ],
        reportedById: made.users[0].id,
      });
    }

    const valueOf = async (leagueId: string, slug: string) =>
      (await db.ownership.findFirstOrThrow({ where: { leagueId, pokemonSlug: slug } })).marketValue;

    it('pays the tier reward, multiplied ×3 from the third straight win and ×5 from the fifth', async () => {
      const made = await ready('ultra');
      const paid: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const { results } = await play(made, true);
        paid.push(results[0].money);
      }
      const r = PAYOUTS.winReward.ultra;
      expect(paid).toEqual([r, r, r * 3, r * 3, r * 5, r * 5]);

      // A loss pays nothing and resets the streak.
      expect((await play(made, false)).results[0].money).toBe(0);
      expect((await play(made, true)).results[0].money).toBe(r);
      expect(await verifyLedger(db, made.league.id)).toEqual([]);
    });

    it('moves the value of the Pokémon that played by the tier percentage', async () => {
      const made = await ready('ultra');
      const garchomp = await valueOf(made.league.id, 'garchomp');
      const torkoal = await valueOf(made.league.id, 'torkoal');

      await play(made, true, true);
      expect(await valueOf(made.league.id, 'garchomp')).toBe(applyPct(garchomp, 5));
      // Brought but never sent out: untouched.
      expect(await valueOf(made.league.id, 'torkoal')).toBe(torkoal);

      await play(made, false);
      expect(await valueOf(made.league.id, 'garchomp')).toBe(applyPct(applyPct(garchomp, 5), -2));
    });

    it('takes back the reward and the value moves when a match is deleted', async () => {
      const made = await ready('master');
      const before = await db.team.findUniqueOrThrow({ where: { id: made.teams[0].id } });
      const garchomp = await valueOf(made.league.id, 'garchomp');

      const { match } = await play(made, true);
      expect(await valueOf(made.league.id, 'garchomp')).not.toBe(garchomp);

      await deleteMatch({ matchId: match.id, actorUserId: made.users[0].id });

      const after = await db.team.findUniqueOrThrow({ where: { id: made.teams[0].id } });
      expect(after.cash).toBe(before.cash);
      expect(after.wins).toBe(0);
      expect(await valueOf(made.league.id, 'garchomp')).toBe(garchomp);
      expect(await db.valueChange.count({ where: { matchId: match.id } })).toBe(0);
      expect(await verifyLedger(db, made.league.id)).toEqual([]);
    });

    it('charges nothing when the round closes', async () => {
      const made = await ready('poke');
      const before = await db.team.findUniqueOrThrow({ where: { id: made.teams[0].id } });
      const garchomp = await valueOf(made.league.id, 'garchomp');

      await advanceRound({ leagueId: made.league.id, actorUserId: made.users[0].id });

      const after = await db.team.findUniqueOrThrow({ where: { id: made.teams[0].id } });
      expect(after.cash).toBe(before.cash);
      expect(await valueOf(made.league.id, 'garchomp')).toBe(garchomp);
    });
  });
});
