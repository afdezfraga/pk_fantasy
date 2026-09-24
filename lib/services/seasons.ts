/**
 * Closing a season and opening the next.
 *
 * Champions resets the ranked ladder every season, so the league does too: every club goes back
 * to Poké Ball 4, and every Pokémon except each club's captain is sold back to the market at its
 * current value. The captain is the one thread a club carries from season to season. The league
 * then waits in setup for a fresh draft — which also means anyone new can join in between.
 */

import { SEASON_START, rungNumber } from '../ladder.ts';
import { db } from '../db.ts';
import { pokemonLabel } from '../format.ts';
import { clearEffectsForSeason } from './effects.ts';
import { standingColumns } from './ladder.ts';
import { audit } from './money.ts';
import { ensureCaptain, releaseToMarket } from './ownership.ts';
import { openNextRound } from './rounds.ts';

export class SeasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonError';
  }
}

export async function advanceSeason(input: { leagueId: string; actorUserId: string }) {
  const league = await db.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  if (league.commissionerId !== input.actorUserId) {
    throw new SeasonError('Only the commissioner can start a new season.');
  }
  if (league.status !== 'ACTIVE') {
    throw new SeasonError(
      league.status === 'SETUP'
        ? 'The new season is already waiting for its draft.'
        : 'Finish the draft before closing the season.',
    );
  }

  const season = league.season;

  return db.$transaction(async (tx) => {
    // Guarded on the season the commissioner saw, so a double click can't close two.
    const moved = await tx.league.updateMany({
      where: { id: input.leagueId, season, status: 'ACTIVE' },
      data: { season: season + 1, status: 'SETUP' },
    });
    if (moved.count !== 1) throw new SeasonError('The season has just changed — refresh.');

    const teams = await tx.team.findMany({ where: { leagueId: input.leagueId } });
    let sold = 0;
    let proceeds = 0;

    for (const team of teams) {
      // A squad from before captains were automatic may not have one yet; it keeps somebody.
      await ensureCaptain(tx, input.leagueId, team.id);

      const outgoing = await tx.ownership.findMany({
        where: { leagueId: input.leagueId, teamId: team.id, captain: false },
        include: { pokemon: { select: { name: true, form: true } } },
      });
      for (const row of outgoing) {
        // Its own ledger type, which also means a transfer freeze can't block it: this is the
        // league closing a season, not the club dealing.
        const result = await releaseToMarket(tx, {
          leagueId: input.leagueId,
          pokemonSlug: row.pokemonSlug,
          teamId: team.id,
          actorUserId: input.actorUserId,
          type: 'SEASON_END',
          description: `Season ${season} over — sold ${pokemonLabel(row.pokemon)}`,
          skipSquadMin: true,
        });
        sold += 1;
        proceeds += result.proceeds;
      }

      // The captain leads the new teamsheet.
      await tx.ownership.updateMany({
        where: { leagueId: input.leagueId, teamId: team.id, captain: true },
        data: { starter: true, slot: 1 },
      });

      await tx.team.update({
        where: { id: team.id },
        data: {
          ...standingColumns(SEASON_START),
          bestRung: rungNumber(SEASON_START),
          standingUpdated: new Date(),
        },
      });
    }

    // Straight onto the open market rather than waivers: the draft wants the whole board.
    await tx.ownership.updateMany({
      where: { leagueId: input.leagueId, teamId: null, status: { not: 'FREE_AGENT' } },
      data: { status: 'FREE_AGENT', waiverUntil: null },
    });

    // Offers on the table name Pokémon that have just gone back to the market.
    await tx.tradeOffer.updateMany({
      where: { leagueId: input.leagueId, status: 'PENDING' },
      data: { status: 'CANCELLED', resolvedAt: new Date() },
    });

    // So does the event board: every offer on it names a squad that is about to be sold, and a
    // bid placed against last season's Pokémon settling into next season's would pay a club for
    // an event it never read. The next board opens once the new draft is done.
    await tx.eventAuction.updateMany({
      where: { leagueId: input.leagueId, status: 'OPEN' },
      data: { status: 'CANCELLED', settledAt: new Date() },
    });
    await tx.league.update({ where: { id: input.leagueId }, data: { boardUntil: null } });

    // One draft per league at a time; the new season gets a fresh one.
    await tx.draft.deleteMany({ where: { leagueId: input.leagueId } });

    // Nothing in force describes the squad that is about to be drafted. Done after the squads
    // are sold so a transfer freeze cannot have blocked the sale, and before the round opens so
    // the refunds land in the season that is closing.
    const { cleared, refunded } = await clearEffectsForSeason(tx, {
      leagueId: input.leagueId,
      round: league.round,
    });

    // A new season is also a new round, so the pay cap starts again with it.
    const opened = await openNextRound(tx, {
      leagueId: input.leagueId,
      round: league.round,
      actorUserId: input.actorUserId,
      reason: 'season',
    });
    if (!opened) throw new SeasonError('The round has just closed — refresh and try again.');

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'SEASON_ADVANCE',
      detail: { closed: season, opened: season + 1, sold, proceeds, cleared, refunded },
    });

    return { season, next: season + 1, sold, proceeds, cleared, refunded };
  });
}
