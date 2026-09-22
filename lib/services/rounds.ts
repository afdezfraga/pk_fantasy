/**
 * Advancing a round: waivers clear, the per-round match pay cap starts again, and the league
 * draws one shared shock for everybody to answer for themselves.
 *
 * There are no wages, upkeep or value drift — money only moves when a team signs, sells, trades,
 * wins, or answers an event, and values only move when a Pokémon plays or an event moves them.
 */

import { db } from '../db.ts';
import { expireByRound } from './effects.ts';
import { drawLeagueEvent } from './events.ts';
import { audit } from './money.ts';

export class RoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundError';
  }
}

export async function advanceRound(input: { leagueId: string; actorUserId: string }) {
  const league = await db.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  if (league.commissionerId !== input.actorUserId) {
    throw new RoundError('Only the commissioner can advance the round.');
  }
  if (league.status !== 'ACTIVE') {
    throw new RoundError('The league needs to finish drafting first.');
  }

  const round = league.round;
  const next = round + 1;

  await db.$transaction(async (tx) => {
    // Waivers clear once their hold expires.
    const cleared = await tx.ownership.updateMany({
      where: { leagueId: input.leagueId, status: 'WAIVERS' },
      data: { status: 'FREE_AGENT' },
    });

    // Restrictions measured in rounds rather than matches end here, and say so.
    await expireByRound(tx, { leagueId: input.leagueId, round: next });

    await tx.league.update({ where: { id: input.leagueId }, data: { round: next } });

    // One round ends and the next begins in the same breath — a league is never between rounds.
    // Everything that happens is stamped with the round it happened in, so this trail plus those
    // stamps is enough to reconstruct any round after the fact.
    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'ROUND_ADVANCE',
      detail: { closed: round, opened: next, waiversCleared: cleared.count },
    });
  });

  // Outside the transaction: a shock failing to draw must not undo the round that closed.
  // Each club gets its own copy to answer, so the same news lands differently everywhere.
  const events = await drawLeagueEvent(input.leagueId, next);

  return { round, events };
}
