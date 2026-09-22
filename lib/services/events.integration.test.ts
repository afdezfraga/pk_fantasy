/**
 * Events against a real database, because the things worth testing here are database things:
 * that two page loads cannot both draw, that a club which cannot pay still has a way out, and
 * that a restriction ends on exactly the match it says it will.
 */

import { describe, expect, it } from 'vitest';

import { LEAGUE_DEFAULTS, type LeagueConfig } from '../../config/economy.ts';
import { db } from '../db.ts';
import { addEffect, activeEffects, EffectViolation, type EffectSpec } from './effects.ts';
import {
  delegateEvent,
  ensurePendingEvent,
  EventPendingError,
  forceResolveEvent,
  parseChoices,
  pendingEvent,
  resolveEvent,
} from './events.ts';
import { createLeague, joinLeague } from './league.ts';
import { deleteMatch, reportMatch } from './matches.ts';
import { InsufficientFunds, verifyLedger } from './money.ts';
import { acquireFreeAgent, sellToMarket } from './ownership.ts';
import { advanceRound } from './rounds.ts';
import { buildContext, fires } from './triggers.ts';

let counter = 0;

const SQUAD = ['incineroar', 'garchomp', 'whimsicott', 'torkoal', 'sableye', 'pikachu'];

/** A league that has finished drafting, with `size` Pokémon signed to the first club. */
async function makeActiveLeague(options: { size?: number; config?: Partial<LeagueConfig> } = {}) {
  counter += 1;
  const size = options.size ?? 6;

  const users = await Promise.all(
    [0, 1].map((index) =>
      db.user.create({
        data: {
          username: `ev-${counter}-${index}`,
          displayName: `Player ${index}`,
          passwordHash: 'x',
        },
      }),
    ),
  );

  const { league, team } = await createLeague({
    name: `Events ${counter}`,
    commissionerId: users[0].id,
    teamName: 'Cinnabar',
    config: { startingCash: 2_000_000, ...options.config },
  });
  const other = await joinLeague({
    inviteCode: league.inviteCode,
    userId: users[1].id,
    teamName: 'Viridian',
  });

  for (const slug of SQUAD.slice(0, size)) {
    const row = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: slug } },
    });
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: slug,
      teamId: team.id,
      price: row.marketValue,
      // The squad arrives the way a real one does — through the draft. Draft picks are not
      // market activity, so setting a club up doesn't make it look like it churned its squad.
      type: 'DRAFT_PICK',
    });
  }

  await db.league.update({ where: { id: league.id }, data: { status: 'ACTIVE' } });

  return { league, team, other: other.team, users };
}

/** Plays a match for the club, honouring whatever it is playing under. */
async function play(
  leagueId: string,
  teamId: string,
  reportedById: string,
  options: { won?: boolean; slugs?: string[]; attested?: string[] } = {},
) {
  const won = options.won ?? true;
  const slugs = options.slugs ?? SQUAD.slice(0, 4);
  return reportMatch({
    leagueId,
    homeTeamId: teamId,
    awayTeamId: null,
    opponentName: 'Ranked ladder',
    homeScore: won ? 4 : 0,
    awayScore: won ? 0 : 4,
    lines: slugs.map((slug) => ({ pokemonSlug: slug, teamId, kos: 1, fainted: false, benched: false })),
    attested: options.attested ?? [],
    reportedById,
  });
}

async function give(leagueId: string, teamId: string, spec: EffectSpec) {
  await db.$transaction(async (tx) => {
    await addEffect(tx, { ...spec, leagueId, teamId });
  });
  return (await activeEffects(leagueId, teamId)).at(-1)!;
}

describe('when an event arrives', () => {
  it('gives every club one the moment the draft ends, before a ball is kicked', async () => {
    const { league, team, users } = await makeActiveLeague();
    // completeDraft zeroes the countdown; the draw itself is lazy.
    await db.team.updateMany({ where: { leagueId: league.id }, data: { eventCountdown: 0 } });

    // 0.5 is above every virtueChance in the deck, so this draws a problem rather than the
    // occasional good day — which resolves itself and would rightly block nobody.
    const drawn = await ensurePendingEvent(league.id, team.id, () => 0.5);
    expect(drawn).not.toBeNull();

    const event = await pendingEvent(league.id, team.id);
    expect(event?.status).toBe('PENDING');
    expect(event?.description).not.toContain('{');

    // And it blocks match one until it is answered.
    await expect(play(league.id, team.id, users[0].id)).rejects.toThrow(EventPendingError);
  });

  it('draws exactly one when two page loads land together', async () => {
    const { league, team } = await makeActiveLeague();
    await db.team.updateMany({ where: { leagueId: league.id }, data: { eventCountdown: 0 } });

    const results = await Promise.allSettled([
      ensurePendingEvent(league.id, team.id, () => 0.5),
      ensurePendingEvent(league.id, team.id, () => 0.5),
      ensurePendingEvent(league.id, team.id, () => 0.5),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    // One *draw*, which is the invariant. Asserting one pending row would be a claim about the
    // deck rather than the race, since a virtue resolves itself the moment it fires.
    const events = await db.leagueEvent.findMany({
      where: { leagueId: league.id, teamId: team.id, status: { not: 'NOTICE' } },
    });
    expect(events).toHaveLength(1);
  });

  it('does nothing while the countdown is still running', async () => {
    const { league, team } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 5 } });
    expect(await ensurePendingEvent(league.id, team.id)).toBeNull();
  });

  it('stays out of a league that has switched events off', async () => {
    const { league, team } = await makeActiveLeague({ config: { eventsEnabled: 0 } });
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    expect(await ensurePendingEvent(league.id, team.id)).toBeNull();
  });

  it('counts down as matches are reported', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 2 } });

    await play(league.id, team.id, users[0].id);
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).eventCountdown).toBe(1);

    await play(league.id, team.id, users[0].id);
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).eventCountdown).toBe(0);
    expect(await ensurePendingEvent(league.id, team.id, () => 0.5)).not.toBeNull();
  });
});

describe('answering it', () => {
  it('charges the option and unblocks the club', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    await ensurePendingEvent(league.id, team.id, () => 0.5);

    const event = (await pendingEvent(league.id, team.id))!;
    const option = parseChoices(event.choices).find((candidate) => candidate.default)!;
    const before = (await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash;

    await resolveEvent({
      eventId: event.id,
      teamId: team.id,
      choiceKey: option.key,
      actorUserId: users[0].id,
    });

    const after = await db.team.findUniqueOrThrow({ where: { id: team.id } });
    expect(after.cash).toBe(before - option.cost);
    expect(await pendingEvent(league.id, team.id)).toBeNull();

    // Answering unblocks the club — though whatever it agreed to now has to be honoured, which
    // is the whole point: the decision follows you onto the field.
    const inForce = await activeEffects(league.id, team.id);
    await expect(
      play(league.id, team.id, users[0].id, {
        attested: inForce.filter((effect) => effect.attested).map((effect) => effect.id),
      }),
    ).resolves.toBeTruthy();
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('refuses an option that was never on the table', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    await ensurePendingEvent(league.id, team.id, () => 0.5);
    const event = (await pendingEvent(league.id, team.id))!;

    await expect(
      resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'nonsense', actorUserId: users[0].id }),
    ).rejects.toThrow(/no longer on the table/);
  });

  it('cannot be answered twice', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    await ensurePendingEvent(league.id, team.id, () => 0.5);
    const event = (await pendingEvent(league.id, team.id))!;
    const key = parseChoices(event.choices).find((option) => option.default)!.key;

    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: key, actorUserId: users[0].id });
    await expect(
      resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: key, actorUserId: users[0].id }),
    ).rejects.toThrow(/already been answered/);
  });

  it('lets the assistant handle it in one click', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    // A delegable template — the deck marks the big decisions as the manager's own.
    await db.leagueEvent.create({
      data: {
        leagueId: league.id,
        teamId: team.id,
        round: 1,
        templateKey: 'test',
        title: 'Something has come up',
        description: 'x',
        detail: JSON.stringify({ delegable: true }),
        status: 'PENDING',
        choices: JSON.stringify([
          { key: 'a', label: 'A', detail: '', default: true, available: true, cost: 0, effects: [] },
          { key: 'b', label: 'B', detail: '', default: false, available: false, cost: 0, effects: [] },
        ]),
      },
    });

    const event = (await pendingEvent(league.id, team.id))!;
    await delegateEvent({ eventId: event.id, teamId: team.id, actorUserId: users[0].id, random: () => 0.99 });

    const after = await db.leagueEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.status).toBe('DELEGATED');
    // Only the open branch was reachable, however the dice fell.
    expect(after.choiceKey).toBe('a');
  });

  it('lets the commissioner force a stuck one through', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    await ensurePendingEvent(league.id, team.id, () => 0.5);
    const event = (await pendingEvent(league.id, team.id))!;

    await forceResolveEvent({ eventId: event.id, actorUserId: users[0].id });
    expect((await db.leagueEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('FORCED');

    await expect(forceResolveEvent({ eventId: event.id, actorUserId: users[1].id })).rejects.toThrow();
  });
});

describe('a club that cannot pay', () => {
  it('goes into the red rather than being stranded', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 4 });
    // Spend it all, then face a bill.
    await db.$transaction(async (tx) => {
      const current = await tx.team.findUniqueOrThrow({ where: { id: team.id } });
      await tx.team.update({ where: { id: team.id }, data: { cash: 0 } });
      await tx.transaction.create({
        data: {
          leagueId: league.id,
          teamId: team.id,
          type: 'ADJUSTMENT',
          amount: -current.cash,
          balanceAfter: 0,
          description: 'Spent it all',
        },
      });
    });

    await db.leagueEvent.create({
      data: {
        leagueId: league.id,
        teamId: team.id,
        round: 1,
        templateKey: 'bill',
        title: 'A bill',
        description: 'x',
        detail: '{}',
        status: 'PENDING',
        choices: JSON.stringify([
          { key: 'pay', label: 'Pay', detail: '', default: true, available: true, cost: 25_000, effects: [] },
        ]),
      },
    });

    const event = (await pendingEvent(league.id, team.id))!;
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'pay', actorUserId: users[0].id });

    const after = await db.team.findUniqueOrThrow({ where: { id: team.id } });
    expect(after.cash).toBe(-25_000);
    // The ledger still balances — debt is a number, not a broken invariant.
    expect(await verifyLedger(db, league.id)).toEqual([]);

    // And debt is its own punishment: nothing can be signed until it is cleared.
    const free = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, teamId: null, pokemonSlug: 'delibird' },
    });
    await expect(
      acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: 'delibird',
        teamId: team.id,
        price: free.marketValue,
        type: 'MARKET_BUY',
      }),
    ).rejects.toThrow(InsufficientFunds);
  });
});

describe('playing under a restriction', () => {
  it('refuses a Pokémon that is out while the club has cover', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    await give(league.id, team.id, {
      kind: 'POKEMON_OUT',
      pokemonSlug: 'garchomp',
      matches: 3,
      label: 'Garchomp — injured',
      liftedMessage: 'Garchomp is fit again.',
    });

    await expect(play(league.id, team.id, users[0].id)).rejects.toThrow(/Pick someone else/);
    // Anyone else is fine.
    await expect(
      play(league.id, team.id, users[0].id, { slugs: ['incineroar', 'whimsicott', 'torkoal', 'sableye'] }),
    ).resolves.toBeTruthy();
  });

  it('lets a cornered club bring it benched, and records a loss if it plays', async () => {
    // Exactly four starters, one of them barred: enforcing would leave no legal lineup at all.
    const { league, team, users } = await makeActiveLeague({ size: 4 });
    await give(league.id, team.id, {
      kind: 'POKEMON_OUT',
      pokemonSlug: 'garchomp',
      matches: 3,
      label: 'Garchomp — suspended',
      liftedMessage: 'Garchomp has served its suspension.',
    });

    const benched = await reportMatch({
      leagueId: league.id,
      homeTeamId: team.id,
      awayTeamId: null,
      opponentName: 'Ranked ladder',
      homeScore: 4,
      awayScore: 0,
      lines: SQUAD.slice(0, 4).map((slug) => ({
        pokemonSlug: slug,
        teamId: team.id,
        kos: slug === 'garchomp' ? 0 : 1,
        fainted: false,
        benched: slug === 'garchomp',
      })),
      reportedById: users[0].id,
    });
    expect(benched.surrendered).toBe(false);
    expect(benched.match.homeScore).toBeGreaterThan(benched.match.awayScore);

    // Sending it out forfeits the match, however the result was typed in.
    const played = await play(league.id, team.id, users[0].id, { won: true });
    expect(played.surrendered).toBe(true);
    expect(played.match.homeScore).toBeLessThan(played.match.awayScore);
    expect(played.match.note).toContain('Surrendered');
    expect(played.results[0].money).toBe(0);
  });

  it('holds the report until an honour-based rule is confirmed', async () => {
    const { league, team, users } = await makeActiveLeague();
    const mega = await give(league.id, team.id, {
      kind: 'NO_MEGA',
      matches: 2,
      label: 'No Mega Evolution',
      liftedMessage: 'Mega Evolution is available again.',
    });

    await expect(play(league.id, team.id, users[0].id)).rejects.toThrow(/Confirm you played under/);

    const result = await play(league.id, team.id, users[0].id, { attested: [mega.id] });
    const stored = JSON.parse(result.match.constraints!);
    expect(stored).toEqual([
      { kind: 'NO_MEGA', label: 'No Mega Evolution', attested: true, honoured: true },
    ]);
  });

  it('scales what a win is worth', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { tierKey: 'ultra' } });
    await give(league.id, team.id, {
      kind: 'PAYOUT_MULT',
      params: { times: 0.5 },
      matches: 4,
      label: 'Unsponsored — winnings at 50%',
      liftedMessage: 'A new sponsor is on board.',
    });

    const result = await play(league.id, team.id, users[0].id);
    // Ultra Ball pays ₽10,000; halved, ₽5,000.
    expect(result.results[0].money).toBe(5_000);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('damps how much a match moves a value', async () => {
    const { league, team, users } = await makeActiveLeague();
    await db.team.update({ where: { id: team.id }, data: { tierKey: 'ultra' } });
    await give(league.id, team.id, {
      kind: 'VALUE_MULT',
      params: { times: 0.5 },
      matches: 4,
      label: 'Carrying knocks — value moves halved',
      liftedMessage: 'The squad is fit again.',
    });

    const before = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'incineroar' } },
    });
    await play(league.id, team.id, users[0].id);
    const after = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'incineroar' } },
    });

    // Ultra Ball wins move +5%; halved, +2.5%.
    expect(after.marketValue).toBe(Math.round(before.marketValue * 1.025));
  });

  it('charges a payment plan every match, and stops when it is paid off', async () => {
    const { league, team, users } = await makeActiveLeague();
    await give(league.id, team.id, {
      kind: 'UPKEEP',
      params: { amount: 6_000 },
      matches: 2,
      label: 'Payment plan — ₽6,000 a match',
      liftedMessage: 'Your accounts are clear.',
    });

    const start = (await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash;
    await play(league.id, team.id, users[0].id, { won: false });
    await play(league.id, team.id, users[0].id, { won: false });
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(start - 12_000);

    // The plan has run its course; a third match costs nothing.
    await play(league.id, team.id, users[0].id, { won: false });
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(start - 12_000);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });
});

describe('when a restriction ends', () => {
  it('lifts on exactly the match it said it would, and says so', async () => {
    const { league, team, users } = await makeActiveLeague();
    await give(league.id, team.id, {
      kind: 'POKEMON_OUT',
      pokemonSlug: 'pikachu',
      matches: 2,
      label: 'Pikachu — injured',
      liftedMessage: 'Pikachu has recovered and is available again.',
    });

    await play(league.id, team.id, users[0].id);
    expect(await activeEffects(league.id, team.id)).toHaveLength(1);

    const second = await play(league.id, team.id, users[0].id);
    expect(await activeEffects(league.id, team.id)).toHaveLength(0);
    expect(second.lifted).toEqual(['Pikachu has recovered and is available again.']);

    // A restriction that ends quietly is one nobody notices they had.
    const notice = await db.leagueEvent.findFirst({
      where: { leagueId: league.id, teamId: team.id, status: 'NOTICE' },
    });
    expect(notice?.description).toBe('Pikachu has recovered and is available again.');
  });

  it('gives the match back when a result is deleted', async () => {
    const { league, team, users } = await makeActiveLeague();
    await give(league.id, team.id, {
      kind: 'NO_WEATHER',
      matches: 3,
      label: 'No weather',
      liftedMessage: 'Set weather freely again.',
    });
    const effect = (await activeEffects(league.id, team.id))[0];

    const result = await play(league.id, team.id, users[0].id, { attested: [effect.id] });
    expect((await activeEffects(league.id, team.id))[0].matchesLeft).toBe(2);

    await deleteMatch({ matchId: result.match.id, actorUserId: users[0].id });
    expect((await activeEffects(league.id, team.id))[0].matchesLeft).toBe(3);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });
});

describe('events you caused', () => {
  /** Plays `count` matches with a fixed four, so everyone else is visibly being ignored. */
  async function grind(
    leagueId: string,
    teamId: string,
    userId: string,
    count: number,
    slugs = SQUAD.slice(0, 4),
  ) {
    for (let index = 0; index < count; index += 1) {
      await play(leagueId, teamId, userId, { slugs });
    }
  }

  it("doesn't call a brand-new signing forgotten", async () => {
    // The bug this covers: counting missed matches against the club's whole history rather than
    // the Pokémon's, so a signing arrived already looking ignored for twenty matches.
    const { league, team, users } = await makeActiveLeague({ size: 5 });
    await grind(league.id, team.id, users[0].id, 12);

    const before = await buildContext(league.id, team.id);
    expect(before!.benched!.matches).toBeGreaterThanOrEqual(10);

    // Sign someone today. It has had no chance to play, so it cannot have missed anything.
    const row = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'delibird' } },
    });
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'delibird',
      teamId: team.id,
      price: row.marketValue,
      type: 'MARKET_BUY',
    });

    const after = await buildContext(league.id, team.id);
    expect(after!.benched!.pokemonSlug).not.toBe('delibird');

    const fresh = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'delibird' } },
    });
    expect(fresh.starter).toBe(true); // it really is in the lineup, and still not "forgotten"
  });

  it('does call a Pokémon forgotten once it has missed ten of its own', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 5 });
    await grind(league.id, team.id, users[0].id, 11);

    const context = await buildContext(league.id, team.id);
    // It names the Pokémon that caused it — the one never picked, not just any of them.
    expect(fires(context!, { benchedMatches: 10 })).toEqual({ fired: true, subject: SQUAD[4] });
  });

  it('only burns out a Pokémon that played all of the last ten', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 5 });

    // Nine isn't ten, however hard they were worked.
    await grind(league.id, team.id, users[0].id, 9);
    expect(fires((await buildContext(league.id, team.id))!, { everyMatchStreak: 10 }).fired).toBe(
      false,
    );

    await grind(league.id, team.id, users[0].id, 1);
    const worked = await buildContext(league.id, team.id);
    expect(worked!.everPresent!.matches).toBe(10);
    expect(fires(worked!, { everyMatchStreak: 10 }).fired).toBe(true);

    // Rest whoever it named. One match off is a breather, so it is no longer the one burning
    // out — even though team-mates who kept playing still are.
    const rested = worked!.everPresent!.pokemonSlug;
    await play(league.id, team.id, users[0].id, {
      slugs: SQUAD.slice(0, 5).filter((slug) => slug !== rested).slice(0, 4),
    });

    const after = await buildContext(league.id, team.id);
    expect(after!.everPresent?.pokemonSlug).not.toBe(rested);
  });

  it('forgets an old grind once it falls out of the ten-match window', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 5 });
    await grind(league.id, team.id, users[0].id, 10);
    expect(fires((await buildContext(league.id, team.id))!, { everyMatchStreak: 10 }).fired).toBe(
      true,
    );

    // Ten matches resting the original four: the window has rolled past their run entirely.
    const others = [SQUAD[4], SQUAD[0], SQUAD[1], SQUAD[2]];
    for (let index = 0; index < 10; index += 1) {
      await play(league.id, team.id, users[0].id, { slugs: others });
    }
    const context = await buildContext(league.id, team.id);
    expect(context!.everPresent?.pokemonSlug).not.toBe(SQUAD[3]);
  });

  it('counts churn by round, not by the clock', async () => {
    const { league, team } = await makeActiveLeague({ size: 6 });
    expect((await buildContext(league.id, team.id))!.churnThisRound).toBe(0);

    await sellToMarket({ leagueId: league.id, pokemonSlug: 'pikachu', teamId: team.id });
    await sellToMarket({ leagueId: league.id, pokemonSlug: 'sableye', teamId: team.id });
    expect((await buildContext(league.id, team.id))!.churnThisRound).toBe(2);

    // Closing the round wipes the slate: last round's business is last round's.
    await db.league.update({ where: { id: league.id }, data: { round: 2 } });
    expect((await buildContext(league.id, team.id))!.churnThisRound).toBe(0);
  });
});

describe('the round is always recorded', () => {
  it('stamps every ledger row with the round it happened in', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 4 });
    await play(league.id, team.id, users[0].id);

    await db.league.update({ where: { id: league.id }, data: { round: 3 } });
    await sellToMarket({ leagueId: league.id, pokemonSlug: 'torkoal', teamId: team.id });

    const rows = await db.transaction.findMany({
      where: { leagueId: league.id, teamId: team.id },
      orderBy: { createdAt: 'asc' },
    });
    // Opening balance, signings and the first match all landed in round 1; the sale in round 3.
    expect(rows.every((row) => row.round > 0)).toBe(true);
    expect(rows.at(-1)!.round).toBe(3);
    expect(rows.filter((row) => row.round === 1).length).toBeGreaterThan(0);
  });

  it('stamps a restriction with the round it came into force', async () => {
    const { league, team } = await makeActiveLeague({ size: 4 });
    await db.league.update({ where: { id: league.id }, data: { round: 4 } });
    await db.team.update({ where: { id: team.id }, data: { eventCountdown: 0 } });
    await ensurePendingEvent(league.id, team.id, () => 0.5);

    const event = (await pendingEvent(league.id, team.id))!;
    expect(event.round).toBe(4);
  });
});

describe('closing a round', () => {
  it('offers every club the same shock to answer for itself', async () => {
    const { league, users } = await makeActiveLeague();
    await db.team.updateMany({ where: { leagueId: league.id }, data: { eventCountdown: 9 } });

    const { events } = await advanceRound({ leagueId: league.id, actorUserId: users[0].id });
    expect(events).toBeGreaterThan(0);

    const pending = await db.leagueEvent.findMany({
      where: { leagueId: league.id, status: 'PENDING' },
    });
    expect(pending.length).toBe(events);
    // Drawing costs nothing — a shock is a decision, not a bill.
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('moves no money in a league with events switched off', async () => {
    const { league, users } = await makeActiveLeague({ config: { eventsEnabled: 0 } });
    const before = await db.team.findMany({ where: { leagueId: league.id } });

    await advanceRound({ leagueId: league.id, actorUserId: users[0].id });

    const after = await db.team.findMany({ where: { leagueId: league.id } });
    expect(after.map((team) => team.cash)).toEqual(before.map((team) => team.cash));
    expect(await db.leagueEvent.count({ where: { leagueId: league.id } })).toBe(0);
  });
});

describe('league defaults', () => {
  it('reach a league created before events existed', () => {
    // parseConfig spreads the defaults, so nothing needs migrating.
    expect(LEAGUE_DEFAULTS.eventsEnabled).toBe(1);
    expect(LEAGUE_DEFAULTS.eventEveryMatches).toBeGreaterThan(0);
  });
});

// --- the events that move Pokémon and money around ----------------------------------------------

/** A pending event with exactly the branches a test wants to take. */
async function stage(
  leagueId: string,
  teamId: string,
  options: { key: string; cost?: number; effects: unknown[] }[],
) {
  await db.team.update({ where: { id: teamId }, data: { eventCountdown: 0 } });
  await db.leagueEvent.create({
    data: {
      leagueId,
      teamId,
      round: 1,
      templateKey: 'staged',
      title: 'Staged',
      description: 'x',
      detail: JSON.stringify({ delegable: true }),
      status: 'PENDING',
      choices: JSON.stringify(
        options.map((option) => ({
          key: option.key,
          label: option.key,
          detail: '',
          default: option.key === options[0].key,
          available: true,
          cost: option.cost ?? 0,
          effects: option.effects,
        })),
      ),
    },
  });
  return (await pendingEvent(leagueId, teamId))!;
}

function lasting(kind: string, params: Record<string, unknown>, matches = 0, rounds = 0) {
  return {
    kind,
    pokemonSlug: null,
    params,
    matches,
    rounds,
    label: `${kind} in force`,
    liftedMessage: `${kind} lifted`,
  };
}

describe('a Pokémon leaving and another arriving', () => {
  it('swaps one for the other without a Pokédollar moving', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const before = await db.team.findUniqueOrThrow({ where: { id: team.id } });

    const event = await stage(league.id, team.id, [
      {
        key: 'swap',
        effects: [
          {
            kind: 'SWAP_OFFER',
            pokemonSlug: 'pikachu',
            params: { slug: 'ditto', amount: 6_000, band: 30 },
            matches: 0,
            rounds: 0,
            label: 'Swapped Pikachu for Ditto',
            liftedMessage: '',
          },
        ],
      },
    ]);

    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'swap', actorUserId: users[0].id });

    const gone = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'pikachu' } },
    });
    const arrived = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'ditto' } },
    });
    expect(gone.teamId).toBeNull();
    expect(arrived.teamId).toBe(team.id);
    // A swap is a swap: the squad is the same size and the balance has not moved.
    expect(await db.ownership.count({ where: { leagueId: league.id, teamId: team.id } })).toBe(6);
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(before.cash);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('substitutes an equivalent when the one it promised has been signed', async () => {
    const { league, team, other, users } = await makeActiveLeague({ size: 6 });
    // Somebody else takes Ditto between the offer and the answer.
    const ditto = await db.ownership.findUniqueOrThrow({
      where: { leagueId_pokemonSlug: { leagueId: league.id, pokemonSlug: 'ditto' } },
    });
    await acquireFreeAgent({
      leagueId: league.id,
      pokemonSlug: 'ditto',
      teamId: other.id,
      price: ditto.marketValue,
      type: 'MARKET_BUY',
    });

    const event = await stage(league.id, team.id, [
      {
        key: 'swap',
        effects: [
          {
            kind: 'SWAP_OFFER',
            pokemonSlug: 'pikachu',
            params: { slug: 'ditto', amount: 6_000, band: 30 },
            matches: 0,
            rounds: 0,
            label: 'Swap',
            liftedMessage: '',
          },
        ],
      },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'swap', actorUserId: users[0].id });

    // Somebody of the same standing arrives instead — the promise was a Pokémon of that value,
    // and failing here would punish a manager for taking a moment to think about it.
    const squad = await db.ownership.findMany({ where: { leagueId: league.id, teamId: team.id } });
    expect(squad).toHaveLength(6);
    expect(squad.map((row) => row.pokemonSlug)).not.toContain('pikachu');
    expect(squad.map((row) => row.pokemonSlug)).not.toContain('ditto');
    expect(squad.some((row) => ['delibird', 'luvdisc', 'furfrou'].includes(row.pokemonSlug))).toBe(true);
  });

  it('takes one and gives two back', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const before = await db.team.findUniqueOrThrow({ where: { id: team.id } });

    const event = await stage(league.id, team.id, [
      {
        key: 'release',
        effects: [
          {
            kind: 'RELEASE_FOR_TWO',
            pokemonSlug: 'torkoal',
            params: { slugs: ['ditto', 'delibird'], count: 2, amount: 28_000 },
            matches: 0,
            rounds: 0,
            label: 'Released Torkoal for Ditto and Delibird',
            liftedMessage: '',
          },
        ],
      },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'release', actorUserId: users[0].id });

    const squad = await db.ownership.findMany({ where: { leagueId: league.id, teamId: team.id } });
    expect(squad).toHaveLength(7);
    const slugs = squad.map((row) => row.pokemonSlug);
    expect(slugs).not.toContain('torkoal');
    expect(slugs).toContain('ditto');
    expect(slugs).toContain('delibird');
    // Depth, not money: nothing was paid for the two and nothing was received for the one.
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(before.cash);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });
});

describe('a wager on results', () => {
  it('pays out the moment the target is reached, with matches to spare', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const event = await stage(league.id, team.id, [
      { key: 'take', effects: [lasting('PLEDGE', { wins: 2, outOf: 5, reward: 10_000, penalty: 4_000 }, 5)] },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'take', actorUserId: users[0].id });
    const before = await db.team.findUniqueOrThrow({ where: { id: team.id } });

    await play(league.id, team.id, users[0].id, { won: true });
    // Halfway: still running, and the strip says where the club has got to.
    const midway = (await activeEffects(league.id, team.id)).find((effect) => effect.kind === 'PLEDGE');
    expect(midway?.label).toContain('1 of 2 wins');

    await play(league.id, team.id, users[0].id, { won: true });

    expect(await activeEffects(league.id, team.id)).toHaveLength(0);
    const after = await db.team.findUniqueOrThrow({ where: { id: team.id } });
    const payouts = await db.transaction.findMany({
      where: { leagueId: league.id, teamId: team.id, type: 'EVENT' },
    });
    expect(payouts.map((row) => row.amount)).toContain(10_000);
    expect(after.cash).toBeGreaterThan(before.cash);

    const notice = await db.leagueEvent.findFirst({
      where: { leagueId: league.id, teamId: team.id, templateKey: 'lifted:pledge' },
    });
    expect(notice?.title).toBe('Target met');
    expect(notice?.description).toContain('2 of 5');
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });

  it('settles a failure as soon as it becomes impossible, not when the window ends', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const event = await stage(league.id, team.id, [
      { key: 'take', effects: [lasting('PLEDGE', { wins: 3, outOf: 3, reward: 30_000, penalty: 9_000 }, 3)] },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'take', actorUserId: users[0].id });
    const before = await db.team.findUniqueOrThrow({ where: { id: team.id } });

    // One defeat and all five wins are already gone. Being told at the third match that you
    // failed at the first is a worse experience than being told at the first.
    await play(league.id, team.id, users[0].id, { won: false });

    expect(await activeEffects(league.id, team.id)).toHaveLength(0);
    const after = await db.team.findUniqueOrThrow({ where: { id: team.id } });
    expect(after.cash).toBe(before.cash - 9_000);
    const notice = await db.leagueEvent.findFirst({
      where: { leagueId: league.id, teamId: team.id, templateKey: 'lifted:pledge' },
    });
    expect(notice?.title).toBe('Target missed');
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });
});

describe('money locked away', () => {
  it('charges now and pays back with interest when the round it names closes', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const before = await db.team.findUniqueOrThrow({ where: { id: team.id } });

    const event = await stage(league.id, team.id, [
      { key: 'buy', effects: [lasting('ESCROW', { amount: 50_000, returnPct: 115 }, 0, 2)] },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'buy', actorUserId: users[0].id });
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(before.cash - 50_000);

    await advanceRound({ leagueId: league.id, actorUserId: users[0].id });
    // Still locked after one round: the terms said two.
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(before.cash - 50_000);

    await advanceRound({ leagueId: league.id, actorUserId: users[0].id });
    expect((await db.team.findUniqueOrThrow({ where: { id: team.id } })).cash).toBe(before.cash + 7_500);
    expect(await verifyLedger(db, league.id)).toEqual([]);
  });
});

describe('a club whose transfers are frozen', () => {
  it('cannot sign, sell or trade until the freeze lifts', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const event = await stage(league.id, team.id, [
      { key: 'decline', effects: [lasting('TRANSFER_FREEZE', {}, 0, 1)] },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'decline', actorUserId: users[0].id });

    const free = await db.ownership.findFirstOrThrow({
      where: { leagueId: league.id, teamId: null, pokemonSlug: 'delibird' },
    });
    await expect(
      acquireFreeAgent({
        leagueId: league.id,
        pokemonSlug: 'delibird',
        teamId: team.id,
        price: free.marketValue,
        type: 'MARKET_BUY',
      }),
    ).rejects.toThrow(EffectViolation);
    await expect(
      sellToMarket({ leagueId: league.id, pokemonSlug: 'pikachu', teamId: team.id }),
    ).rejects.toThrow(EffectViolation);

    await advanceRound({ leagueId: league.id, actorUserId: users[0].id });

    // And the freeze announces its own end, like every other restriction.
    const lifted = await db.leagueEvent.findFirst({
      where: { leagueId: league.id, teamId: team.id, templateKey: 'lifted:transfer_freeze' },
    });
    expect(lifted?.status).toBe('NOTICE');

    await expect(
      sellToMarket({ leagueId: league.id, pokemonSlug: 'pikachu', teamId: team.id }),
    ).resolves.toBeTruthy();
  });
});

describe('deleting a result the wager counted', () => {
  it('gives back the match and the win together', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });
    const event = await stage(league.id, team.id, [
      { key: 'take', effects: [lasting('PLEDGE', { wins: 2, outOf: 5, reward: 10_000, penalty: 4_000 }, 5)] },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'take', actorUserId: users[0].id });

    const first = await play(league.id, team.id, users[0].id, { won: true });
    const running = (await activeEffects(league.id, team.id)).find((effect) => effect.kind === 'PLEDGE');
    expect(running?.matchesLeft).toBe(4);
    expect(running?.params.won).toBe(1);

    await deleteMatch({ matchId: first.match.id, actorUserId: users[0].id });

    // Returning the match without returning the win would quietly make the target easier.
    const after = (await activeEffects(league.id, team.id)).find((effect) => effect.kind === 'PLEDGE');
    expect(after?.matchesLeft).toBe(5);
    expect(after?.params.won).toBe(0);
    expect(after?.label).toContain('0 of 2 wins');
  });
});

describe('a decision the rest of the squad watched', () => {
  it('puts the milder version in force on the others too', async () => {
    const { league, team, users } = await makeActiveLeague({ size: 6 });

    const event = await stage(league.id, team.id, [
      {
        key: 'refuse',
        effects: [
          { ...lasting('ZERO_EVS', {}, 5), pokemonSlug: 'garchomp', label: 'Garchomp — no EVs' },
          { ...lasting('ZERO_EVS', {}, 2), pokemonSlug: 'torkoal', label: 'Torkoal — unsettled by it' },
          { ...lasting('ZERO_EVS', {}, 2), pokemonSlug: 'sableye', label: 'Sableye — unsettled by it' },
        ],
      },
    ]);
    await resolveEvent({ eventId: event.id, teamId: team.id, choiceKey: 'refuse', actorUserId: users[0].id });

    const live = await activeEffects(league.id, team.id);
    const byPokemon = new Map(live.map((effect) => [effect.pokemonSlug, effect.matchesLeft]));
    expect(live).toHaveLength(3);
    // The one it happened to carries it longest; the ones who watched get over it sooner.
    expect(byPokemon.get('garchomp')).toBe(5);
    expect(byPokemon.get('torkoal')).toBe(2);
    expect(byPokemon.get('sableye')).toBe(2);

    // And all three have to be confirmed before the club can report again.
    await expect(play(league.id, team.id, users[0].id)).rejects.toThrow(EffectViolation);
    await expect(
      play(league.id, team.id, users[0].id, { attested: live.map((effect) => effect.id) }),
    ).resolves.toBeTruthy();
  });
});
