/**
 * Recording where each player sits on the Champions ranked ladder.
 *
 * Matches are played on the public ladder, not against each other, so this — not head-to-head
 * results — is what the league table is built on. Players report their own standing; the app
 * trusts them and records who said what.
 */

import {
  LADDER,
  UNRANKED,
  formatStanding,
  getTier,
  ladderScore,
  progressPerRank,
  rungNumber,
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

function validate(standing: Standing): void {
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

/**
 * Records a team's current ladder standing and pays any promotion bonuses earned.
 *
 * Bonuses are paid against `bestRung` — the highest rung the team has ever held — so a player
 * who slips a rank and climbs back doesn't get paid twice for the same promotion.
 */
export async function updateStanding(input: {
  leagueId: string;
  teamId: string;
  standing: Standing;
  actorUserId: string;
}) {
  validate(input.standing);

  return db.$transaction(async (tx) => {
    const team = await tx.team.findUniqueOrThrow({ where: { id: input.teamId } });
    if (team.leagueId !== input.leagueId) throw new LadderError('That team is in another league.');

    const league = await tx.league.findUniqueOrThrow({ where: { id: input.leagueId } });

    const before = standingOf(team);
    const beforeRung = rungNumber(before);
    const afterRung = rungNumber(input.standing);

    // The first time you record a standing you're telling the app where you already are, not
    // climbing there. Paying promotion bonuses for that would hand a big windfall to anyone who
    // joins the league already sitting in Ultra Ball.
    const isBaseline = team.standingUpdated === null;

    const tier = getTier(input.standing.tierKey);
    const rated = Boolean(tier.rated);

    await tx.team.update({
      where: { id: input.teamId },
      data: {
        tierKey: input.standing.tierKey,
        ladderRank: tier.ranks === 0 ? null : input.standing.rank,
        ladderProgress: rated ? 0 : input.standing.progress,
        ratingPoints: rated ? input.standing.ratingPoints : null,
        globalPlacement: rated ? input.standing.globalPlacement : null,
        bestRung: Math.max(team.bestRung, afterRung),
        standingUpdated: new Date(),
      },
    });

    // Pay only for rungs above the team's all-time best, so re-climbing isn't farmable.
    const newRungs = isBaseline ? 0 : Math.max(0, afterRung - Math.max(beforeRung, team.bestRung));
    let bonus = 0;
    if (newRungs > 0) {
      const crossedTier = input.standing.tierKey !== before.tierKey;
      bonus =
        newRungs * LADDER.promotionBonus.rank +
        (crossedTier ? LADDER.promotionBonus.tier : 0);

      await postEntry(tx, {
        leagueId: input.leagueId,
        teamId: input.teamId,
        type: 'EVENT',
        amount: bonus,
        description: `Promoted to ${formatStanding(input.standing)}`,
      });
    }

    if (!isBaseline && (afterRung !== beforeRung || input.standing.tierKey !== before.tierKey)) {
      await tx.rankEvent.create({
        data: {
          leagueId: input.leagueId,
          teamId: input.teamId,
          fromLabel: formatStanding(before),
          toLabel: formatStanding(input.standing),
          rungDelta: afterRung - beforeRung,
          bonus,
          round: league.round,
        },
      });
    }

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'LADDER_UPDATE',
      detail: { teamId: input.teamId, to: formatStanding(input.standing), bonus },
    });

    return { bonus, label: formatStanding(input.standing), baseline: isBaseline };
  });
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

export { UNRANKED };

export async function getRankEvents(leagueId: string, take = 8) {
  return db.rankEvent.findMany({
    where: { leagueId },
    include: { team: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}
