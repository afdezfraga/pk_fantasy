/**
 * Advancing a round: waivers clear and the per-round match pay cap starts again.
 *
 * There are no wages, upkeep or value drift any more — money only moves when a team signs, sells,
 * trades or wins, and values only move when a Pokémon plays. Random events stay parked in
 * lib/services/events.ts until they come back as decisions players make.
 */

import { db } from '../db.ts';
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

  await db.$transaction(async (tx) => {
    // Waivers clear once their hold expires.
    const cleared = await tx.ownership.updateMany({
      where: { leagueId: input.leagueId, status: 'WAIVERS' },
      data: { status: 'FREE_AGENT' },
    });

    await tx.league.update({ where: { id: input.leagueId }, data: { round: round + 1 } });

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'ROUND_ADVANCE',
      detail: { round, waiversCleared: cleared.count },
    });
  });

  return { round };
}
