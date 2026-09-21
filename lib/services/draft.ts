/**
 * Snake draft: the initial allocation of an exclusive Pokémon pool.
 *
 * Teams pick in order, reversing each round, and *pay the shop price* for what they take. Paying
 * during the draft is what makes the opening budget bite from pick one — otherwise the draft
 * would hand out the best Pokémon for free and the economy wouldn't start until the first trade.
 *
 * Auction drafts arrive with the rest of the auction system in M4.
 */

import { db } from '../db.ts';
import { parseConfig } from './ownership.ts';
import { acquireFreeAgent } from './ownership.ts';
import { audit } from './money.ts';

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

/**
 * Whose turn it is at a given pick index.
 *
 * Snake order: round 0 runs forwards, round 1 backwards, and so on, so the team that picks last
 * in one round picks first in the next. Without that, pick #1 would be a permanent advantage.
 */
export function pickSlot(order: string[], cursor: number): { round: number; teamId: string } {
  const teams = order.length;
  const round = Math.floor(cursor / teams);
  const indexInRound = cursor % teams;
  const isReversed = round % 2 === 1;
  const teamIndex = isReversed ? teams - 1 - indexInRound : indexInRound;
  return { round, teamId: order[teamIndex] };
}

/** The full pick order, for showing people what's coming. */
export function buildSchedule(order: string[], rounds: number) {
  return Array.from({ length: order.length * rounds }, (_, cursor) => ({
    overall: cursor,
    ...pickSlot(order, cursor),
  }));
}

/** Randomises the draft order. Fairer than creation order, which rewards signing up first. */
export function shuffle<T>(items: readonly T[], random = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function startDraft(input: {
  leagueId: string;
  actorUserId: string;
  rounds?: number;
}) {
  return db.$transaction(async (tx) => {
    const league = await tx.league.findUniqueOrThrow({
      where: { id: input.leagueId },
      include: { teams: true, draft: true },
    });

    if (league.commissionerId !== input.actorUserId) {
      throw new DraftError('Only the commissioner can start the draft.');
    }
    if (league.draft) throw new DraftError('This league has already drafted.');
    // A one-team league is a solo career mode: the draft just becomes picking your own squad.
    if (league.teams.length < 1) throw new DraftError('You need at least one team to draft.');

    const config = parseConfig(league.config);
    const rounds = input.rounds ?? config.draftRounds;

    const order = shuffle(league.teams.map((team) => team.id));

    const draft = await tx.draft.create({
      data: {
        leagueId: league.id,
        type: 'SNAKE',
        status: 'ACTIVE',
        rounds,
        cursor: 0,
        order: JSON.stringify(order),
        startedAt: new Date(),
      },
    });

    await tx.league.update({ where: { id: league.id }, data: { status: 'DRAFTING' } });

    await audit(tx, {
      leagueId: league.id,
      actorUserId: input.actorUserId,
      action: 'DRAFT_START',
      detail: { rounds, order },
    });

    return draft;
  });
}

export interface DraftState {
  draft: NonNullable<Awaited<ReturnType<typeof db.draft.findUnique>>>;
  order: string[];
  totalPicks: number;
  onTheClock: { round: number; teamId: string } | null;
  isComplete: boolean;
}

export async function getDraftState(leagueId: string): Promise<DraftState | null> {
  const draft = await db.draft.findUnique({ where: { leagueId } });
  if (!draft) return null;

  const order: string[] = JSON.parse(draft.order);
  const totalPicks = order.length * draft.rounds;
  const isComplete = draft.cursor >= totalPicks;

  return {
    draft,
    order,
    totalPicks,
    onTheClock: isComplete ? null : pickSlot(order, draft.cursor),
    isComplete,
  };
}

/**
 * Passes the current pick.
 *
 * A team that has spent up to the cap may not be able to afford anything left on the board.
 * Without a way past that, the draft would stall forever and the league could never start —
 * so the slot can always be given up, and the draft always terminates.
 */
export async function passPick(input: {
  leagueId: string;
  teamId: string;
  actorUserId: string;
}) {
  const draft = await db.draft.findUnique({ where: { leagueId: input.leagueId } });
  if (!draft) throw new DraftError('This league has no draft.');
  if (draft.status !== 'ACTIVE') throw new DraftError('The draft is not running.');

  const order: string[] = JSON.parse(draft.order);
  const totalPicks = order.length * draft.rounds;
  const cursor = draft.cursor;
  if (cursor >= totalPicks) throw new DraftError('The draft is already finished.');

  const slot = pickSlot(order, cursor);
  if (slot.teamId !== input.teamId) throw new DraftError("It's not your turn.");

  const claimed = await db.draft.updateMany({
    where: { id: draft.id, cursor },
    data: { cursor: cursor + 1 },
  });
  if (claimed.count !== 1) throw new DraftError('That pick was just made — refresh.');

  await db.draftPick.create({
    data: {
      draftId: draft.id,
      overall: cursor,
      round: slot.round,
      teamId: input.teamId,
      pokemonSlug: null,
      price: 0,
    },
  });

  if (cursor + 1 >= totalPicks) await completeDraft(input.leagueId, draft.id);
  else await autoAdvanceStalled(input.leagueId);

  return { passed: true };
}

/** Ends the draft where it stands. The commissioner's escape hatch. */
export async function finishDraft(input: { leagueId: string; actorUserId: string }) {
  const league = await db.league.findUniqueOrThrow({
    where: { id: input.leagueId },
    include: { draft: true },
  });
  if (league.commissionerId !== input.actorUserId) {
    throw new DraftError('Only the commissioner can end the draft.');
  }
  if (!league.draft) throw new DraftError('This league has no draft.');
  if (league.draft.status === 'COMPLETE') throw new DraftError('The draft is already finished.');

  await completeDraft(input.leagueId, league.draft.id);
  return { finished: true };
}

/**
 * Skips past any team that cannot afford a single Pokémon left on the board.
 *
 * Spending everything on one S-tier is a real strategy, and the consequence is simply that
 * you sit out the rest of the draft with a small squad. Making people click "pass" three times
 * to express that would be nothing but friction — and if every remaining team is priced out,
 * this is also what lets the draft finish instead of hanging.
 */
export async function autoAdvanceStalled(leagueId: string): Promise<number> {
  let skipped = 0;

  for (let guard = 0; guard < 200; guard += 1) {
    const draft = await db.draft.findUnique({ where: { leagueId } });
    if (!draft || draft.status !== 'ACTIVE') break;

    const order: string[] = JSON.parse(draft.order);
    const totalPicks = order.length * draft.rounds;
    const cursor = draft.cursor;
    if (cursor >= totalPicks) {
      await completeDraft(leagueId, draft.id);
      break;
    }

    const slot = pickSlot(order, cursor);
    const league = await db.league.findUniqueOrThrow({ where: { id: leagueId } });
    const config = parseConfig(league.config);

    const team = await db.team.findUniqueOrThrow({ where: { id: slot.teamId } });
    const squadSize = await db.ownership.count({ where: { leagueId, teamId: team.id } });
    const budget = team.cash;

    const cheapest = await db.ownership.findFirst({
      where: { leagueId, teamId: null, pokemon: { legal: true } },
      orderBy: { marketValue: 'asc' },
      select: { marketValue: true },
    });

    const squadFull = squadSize >= config.squadMax;
    const cannotAfford = !cheapest || cheapest.marketValue > budget;
    if (!cannotAfford && !squadFull) break;

    const claimed = await db.draft.updateMany({
      where: { id: draft.id, cursor },
      data: { cursor: cursor + 1 },
    });
    if (claimed.count !== 1) break;

    await db.draftPick.create({
      data: {
        draftId: draft.id,
        overall: cursor,
        round: slot.round,
        teamId: slot.teamId,
        pokemonSlug: null,
        price: 0,
      },
    });
    skipped += 1;

    if (cursor + 1 >= totalPicks) {
      await completeDraft(leagueId, draft.id);
      break;
    }
  }

  return skipped;
}

async function completeDraft(leagueId: string, draftId: string) {
  await db.$transaction([
    db.draft.update({
      where: { id: draftId },
      data: { status: 'COMPLETE', completedAt: new Date() },
    }),
    db.league.update({ where: { id: leagueId }, data: { status: 'ACTIVE' } }),
  ]);
}

/**
 * Makes one pick.
 *
 * The turn check and the cursor advance both run against the cursor value we read, so two
 * people submitting at the same instant can't both consume the same slot.
 */
export async function makePick(input: {
  leagueId: string;
  teamId: string;
  pokemonSlug: string;
  actorUserId: string;
}) {
  const draft = await db.draft.findUnique({ where: { leagueId: input.leagueId } });
  if (!draft) throw new DraftError('This league has no draft.');
  if (draft.status !== 'ACTIVE') throw new DraftError('The draft is not running.');

  const order: string[] = JSON.parse(draft.order);
  const totalPicks = order.length * draft.rounds;
  const cursor = draft.cursor;
  if (cursor >= totalPicks) throw new DraftError('The draft is already finished.');

  const slot = pickSlot(order, cursor);
  if (slot.teamId !== input.teamId) throw new DraftError("It's not your turn to pick.");

  // Claim the slot first. If someone else's request already advanced the cursor, this matches
  // nothing and we stop before touching ownership or money.
  const claimed = await db.draft.updateMany({
    where: { id: draft.id, cursor },
    data: { cursor: cursor + 1 },
  });
  if (claimed.count !== 1) throw new DraftError('That pick was just made — refresh.');

  const pokemon = await db.pokemon.findUniqueOrThrow({ where: { slug: input.pokemonSlug } });

  try {
    const result = await acquireFreeAgent({
      leagueId: input.leagueId,
      pokemonSlug: input.pokemonSlug,
      teamId: input.teamId,
      price: pokemon.baseValue,
      type: 'DRAFT_PICK',
      actorUserId: input.actorUserId,
    });

    await db.draftPick.create({
      data: {
        draftId: draft.id,
        overall: cursor,
        round: slot.round,
        teamId: input.teamId,
        pokemonSlug: input.pokemonSlug,
        price: pokemon.baseValue,
      },
    });

    if (cursor + 1 >= totalPicks) await completeDraft(input.leagueId, draft.id);

    return { ...result, overall: cursor, round: slot.round };
  } catch (error) {
    // Hand the slot back so a failed pick (someone sniped it, or the team can't afford it)
    // doesn't silently burn the team's turn.
    await db.draft.updateMany({
      where: { id: draft.id, cursor: cursor + 1 },
      data: { cursor },
    });
    throw error;
  }
}
