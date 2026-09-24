/**
 * Recording where each player sits on the Champions ranked ladder.
 *
 * Matches are played on the public ladder, not against each other, so this — not head-to-head
 * results — is what the league table is built on. Players report their own standing with each
 * match result; the app trusts them and records who said what.
 */

import type { Prisma } from '@prisma/client';

import {
  LADDER,
  formatStanding,
  getTier,
  ladderScore,
  progressPerRank,
  promotionRewards,
  rungNumber,
  tierIndex,
  type Standing,
} from '../ladder.ts';
import { db } from '../db.ts';
import { audit, postEntry } from './money.ts';

export class LadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LadderError';
  }
}

export interface TeamStandingRow {
  teamId: string;
  standing: Standing;
  score: number;
}

/** Reads a team row into a `Standing`. */
export function standingOf(team: {
  tierKey: string;
  ladderRank: number | null;
  ladderProgress: number;
  ratingPoints: number | null;
  globalPlacement: number | null;
}): Standing {
  return {
    tierKey: team.tierKey,
    rank: team.ladderRank,
    progress: team.ladderProgress,
    ratingPoints: team.ratingPoints,
    globalPlacement: team.globalPlacement,
  };
}

/** The Team columns a standing is stored in. Rated tiers keep a rating, the rest a gauge. */
export function standingColumns(standing: Standing) {
  const tier = getTier(standing.tierKey);
  const rated = Boolean(tier.rated);
  return {
    tierKey: standing.tierKey,
    ladderRank: tier.ranks === 0 ? null : standing.rank,
    ladderProgress: rated ? 0 : standing.progress,
    ratingPoints: rated ? standing.ratingPoints : null,
    globalPlacement: rated ? standing.globalPlacement : null,
  };
}

export function validate(standing: Standing): void {
  const tier = getTier(standing.tierKey);
  if (!LADDER.tiers.some((t) => t.key === standing.tierKey)) {
    throw new LadderError('That rank is not part of the ladder.');
  }
  if (tier.ranks > 0) {
    if (standing.rank === null || standing.rank < 1 || standing.rank > tier.ranks) {
      throw new LadderError(`${tier.name} runs from rank ${tier.ranks} up to rank 1.`);
    }
    const gauge = progressPerRank(standing.tierKey);
    if (standing.progress < 0 || standing.progress > gauge) {
      throw new LadderError(`${tier.name} ranks take ${gauge} steps, so progress runs 0 to ${gauge}.`);
    }
  }
  if (standing.ratingPoints !== null && !Number.isFinite(standing.ratingPoints)) {
    throw new LadderError('Rating points must be a number.');
  }
  if (standing.ratingPoints !== null && standing.ratingPoints < 0) {
    throw new LadderError('Rating points cannot be negative.');
  }
  if (
    standing.globalPlacement !== null &&
    (!Number.isInteger(standing.globalPlacement) || standing.globalPlacement < 1)
  ) {
    throw new LadderError('Global placement must be a whole number, 1 or higher.');
  }
}

export type StandingSource =
  /** Reported with a match result — the intended way a rank moves, and the only one that pays. */
  | 'MATCH'
  /** Typed in by hand to fix a wrong starting rank or a mistake along the way. */
  | 'MANUAL';

/**
 * Checks that a match could plausibly have produced this rank change.
 *
 * The game is the authority and the player types what it says, so this is deliberately loose —
 * it only stops the moves that would pay a bonus the match can't have earned. One match climbs
 * at most one tier, a loss never promotes a tier, and the game never demotes one.
 */
export function assertMatchMove(before: Standing, after: Standing, won: boolean): void {
  const from = tierIndex(before.tierKey);
  const to = tierIndex(after.tierKey);
  if (to < from) {
    throw new LadderError(
      `The game never drops you out of ${getTier(before.tierKey).name}. If your rank is wrong, correct it from the rank settings.`,
    );
  }
  if (to > from + 1) {
    throw new LadderError('One match can only take you up one tier. If your rank is wrong, correct it from the rank settings.');
  }
  if (to > from && !won) {
    throw new LadderError('A loss can’t promote you a tier. Check the result, or correct your rank from the rank settings.');
  }
}

/**
 * Writes a team's ladder standing inside a transaction somebody else opened, and pays any
 * promotion bonus the move earned.
 *
 * A bonus is paid for each ball tier a *match* takes the team into for the first time this
 * season (see `promotionRewards`). A hand correction moves the rank and pays nothing: it exists
 * to fix a wrong starting rank or a mistake, and paying for it would make the correction the
 * cheapest way up. It also leaves the season peak alone, so a genuine climb afterwards still pays.
 */
export async function recordStanding(
  tx: Prisma.TransactionClient,
  input: {
    leagueId: string;
    teamId: string;
    standing: Standing;
    actorUserId: string | null;
    source: StandingSource;
    matchId?: string;
  },
) {
  validate(input.standing);

  const team = await tx.team.findUniqueOrThrow({ where: { id: input.teamId } });
  if (team.leagueId !== input.leagueId) throw new LadderError('That team is in another league.');
  const league = await tx.league.findUniqueOrThrow({ where: { id: input.leagueId } });

  const before = standingOf(team);
  const beforeRung = rungNumber(before);
  const afterRung = rungNumber(input.standing);

  const fromMatch = input.source === 'MATCH';

  const rewards = fromMatch ? promotionRewards(before, input.standing, team.bestRung) : [];
  const bonus = rewards.reduce((sum, reward) => sum + reward.amount, 0);

  await tx.team.update({
    where: { id: input.teamId },
    data: {
      ...standingColumns(input.standing),
      bestRung: fromMatch ? Math.max(team.bestRung, afterRung) : team.bestRung,
      standingUpdated: new Date(),
    },
  });

  for (const reward of rewards) {
    // Its own ledger type: `EVENT` means a random event now that those are decisions clubs
    // make, and the feed exists to explain surprise money.
    await postEntry(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      type: 'PROMOTION',
      amount: reward.amount,
      description: `Reached ${reward.name}`,
      relatedId: input.matchId,
      round: league.round,
    });
  }

  if (afterRung !== beforeRung) {
    await tx.rankEvent.create({
      data: {
        leagueId: input.leagueId,
        teamId: input.teamId,
        fromLabel: formatStanding(before),
        toLabel: formatStanding(input.standing),
        rungDelta: afterRung - beforeRung,
        bonus,
        round: league.round,
        matchId: input.matchId ?? null,
      },
    });
  }

  await audit(tx, {
    leagueId: input.leagueId,
    actorUserId: input.actorUserId,
    action: fromMatch ? 'LADDER_UPDATE' : 'LADDER_CORRECTION',
    detail: {
      teamId: input.teamId,
      from: formatStanding(before),
      to: formatStanding(input.standing),
      bonus,
      matchId: input.matchId ?? null,
    },
  });

  return {
    bonus,
    rewards,
    label: formatStanding(input.standing),
    before,
    bestRungBefore: team.bestRung,
  };
}

/**
 * Corrects a team's ladder standing by hand.
 *
 * Reporting a match is how a rank normally moves. This is the fallback for when the rank on file
 * is wrong — a club that didn't start at Poké Ball 4, or a report that got it wrong — and so it
 * never pays a promotion bonus.
 */
export async function updateStanding(input: {
  leagueId: string;
  teamId: string;
  standing: Standing;
  actorUserId: string;
}) {
  return db.$transaction((tx) => recordStanding(tx, { ...input, source: 'MANUAL' }));
}

/** League table order: ladder position first, then fantasy points as a tie-break. */
export function sortByLadder<
  T extends {
    tierKey: string;
    ladderRank: number | null;
    ladderProgress: number;
    ratingPoints: number | null;
    globalPlacement: number | null;
    points: number;
    name: string;
  },
>(teams: T[]): T[] {
  return [...teams].sort((a, b) => {
    const diff = ladderScore(standingOf(b)) - ladderScore(standingOf(a));
    if (diff !== 0) return diff;
    // Inside a rated tier a better (smaller) global placement wins.
    if (a.globalPlacement !== null && b.globalPlacement !== null && a.globalPlacement !== b.globalPlacement) {
      return a.globalPlacement - b.globalPlacement;
    }
    return b.points - a.points || a.name.localeCompare(b.name);
  });
}

export async function getRankEvents(leagueId: string, take = 8) {
  return db.rankEvent.findMany({
    where: { leagueId },
    include: { team: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}
