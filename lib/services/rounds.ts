/**
 * Advancing a round: waivers clear, the per-round match pay cap starts again, and restrictions
 * measured in rounds lift.
 *
 * A round used to close with one shock dealt to every club. It no longer draws anything: the
 * whole untriggered deck is auctioned on the event board instead, on the clock rather than on
 * the round, so what a club takes on is something it chose and was paid for.
 *
 * A round closes by itself once at least half the clubs have played every match it pays for
 * (`closeRoundIfDone`), and the commissioner can close it early. There are no wages, upkeep or
 * value drift — money only moves when a team signs, sells, trades, wins, climbs, or answers an
 * event, and values only move when a Pokémon plays or an event moves them.
 */

import type { Prisma } from '@prisma/client';

import { PAYOUTS } from '../../config/scoring.ts';
import { db } from '../db.ts';
import { expireByRound } from './effects.ts';
import { expireListings } from './listings.ts';
import { audit } from './money.ts';

export class RoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundError';
  }
}

/**
 * Moves the league from `round` to the next one, inside a transaction somebody else opened.
 *
 * Guarded on the round the caller saw: the automatic close runs after every report, so two
 * reports landing together can both decide the round is over, and only one of them may close
 * it. Returns false for the one that lost.
 */
export async function openNextRound(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; round: number; actorUserId: string | null; reason: string },
): Promise<boolean> {
  const next = input.round + 1;

  const moved = await tx.league.updateMany({
    where: { id: input.leagueId, round: input.round },
    data: { round: next },
  });
  if (moved.count !== 1) return false;

  // Waivers clear once their hold expires.
  const cleared = await tx.ownership.updateMany({
    where: { leagueId: input.leagueId, status: 'WAIVERS' },
    data: { status: 'FREE_AGENT' },
  });

  // Restrictions measured in rounds rather than matches end here, and say so.
  await expireByRound(tx, { leagueId: input.leagueId, round: next });

  // So does a Pokémon nobody came for. It stays where it is, and its club is told.
  await expireListings(tx, { leagueId: input.leagueId, round: next });

  // One round ends and the next begins in the same breath — a league is never between rounds.
  // Everything that happens is stamped with the round it happened in, so this trail plus those
  // stamps is enough to reconstruct any round after the fact.
  await audit(tx, {
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    action: 'ROUND_ADVANCE',
    detail: {
      closed: input.round,
      opened: next,
      waiversCleared: cleared.count,
      reason: input.reason,
    },
  });
  return true;
}

/** Closes the current round. Null if it already moved. */
async function closeRound(input: {
  leagueId: string;
  round: number;
  actorUserId: string | null;
  reason: string;
}) {
  const closed = await db.$transaction((tx) => openNextRound(tx, input));
  if (!closed) return null;
  return { round: input.round };
}

/** The commissioner closing the round early, without waiting for the matches to be played. */
export async function advanceRound(input: { leagueId: string; actorUserId: string }) {
  const league = await db.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  if (league.commissionerId !== input.actorUserId) {
    throw new RoundError('Only the commissioner can advance the round.');
  }
  if (league.status !== 'ACTIVE') {
    throw new RoundError('The league needs to finish drafting first.');
  }

  const result = await closeRound({
    leagueId: input.leagueId,
    round: league.round,
    actorUserId: input.actorUserId,
    reason: 'commissioner',
  });
  if (!result) throw new RoundError('The round has just closed — refresh.');
  return result;
}

/**
 * How far the current round is from closing by itself.
 *
 * A club is done once it has played every match the round pays for. Waiting for everyone would
 * let the slowest player hold the league up; half is enough to say the round has been played.
 */
export async function roundProgress(leagueId: string, round: number) {
  const [teams, played] = await Promise.all([
    db.team.count({ where: { leagueId } }),
    db.match.groupBy({
      by: ['homeTeamId'],
      where: { leagueId, round },
      _count: { _all: true },
    }),
  ]);

  const done = played.filter((row) => row._count._all >= PAYOUTS.paidMatchesPerRound).length;
  const needed = Math.max(1, Math.ceil(teams / 2));
  return { teams, done, needed, matchesEach: PAYOUTS.paidMatchesPerRound, complete: done >= needed };
}

/** Closes the round if enough clubs have played it out. Run after every reported match. */
export async function closeRoundIfDone(leagueId: string) {
  const league = await db.league.findUniqueOrThrow({ where: { id: leagueId } });
  if (league.status !== 'ACTIVE') return null;

  const progress = await roundProgress(leagueId, league.round);
  if (!progress.complete) return null;

  return closeRound({ leagueId, round: league.round, actorUserId: null, reason: 'played out' });
}
