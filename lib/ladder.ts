/**
 * The Champions ranked ladder: parsing, ordering and formatting a standing.
 *
 * League position *is* ladder position — everyone grinds the ranked ladder separately, so the
 * table is "who has climbed highest", not "who beat whom". Players report their own standing.
 *
 * Pure functions; the ladder shape lives in `data/ranks.json` so it can be corrected without
 * touching code.
 */

import ranksFile from '../data/ranks.json' with { type: 'json' };

export interface LadderTier {
  key: string;
  name: string;
  short: string;
  /** Ranks within the tier, counting DOWN from this number to 1. Zero means no sub-ranks. */
  ranks: number;
  /** Gauge steps needed to clear one rank. Differs per tier: Poké 3, Great 4, Ultra 5. */
  progress: number;
  color: string;
  /** Master Ball and Champion use a rating and a global placement instead of a gauge. */
  rated?: boolean;
}

export const LADDER = {
  tiers: ranksFile.tiers as LadderTier[],
  winProgress: ranksFile.winProgress,
  streakBonusProgress: ranksFile.streakBonusProgress,
  lossProgress: ranksFile.lossProgress,
  promotionBonus: ranksFile.promotionBonus,
};

export interface Standing {
  tierKey: string;
  /** Counts down: 4 is the bottom of a tier, 1 the top. Null for tiers without sub-ranks. */
  rank: number | null;
  progress: number;
  /** Rating points, for rated tiers. e.g. 1703.462 */
  ratingPoints: number | null;
  /** Global placement, for rated tiers. e.g. 123329 — lower is better. */
  globalPlacement: number | null;
}

export const UNRANKED: Standing = {
  tierKey: 'beginner',
  rank: null,
  progress: 0,
  ratingPoints: null,
  globalPlacement: null,
};

export function getTier(tierKey: string): LadderTier {
  return LADDER.tiers.find((tier) => tier.key === tierKey) ?? LADDER.tiers[0];
}

export function tierIndex(tierKey: string): number {
  const index = LADDER.tiers.findIndex((tier) => tier.key === tierKey);
  return index === -1 ? 0 : index;
}

export function isRated(tierKey: string): boolean {
  return Boolean(getTier(tierKey).rated);
}

/** Gauge steps needed to clear a rank in this tier. Higher tiers demand more. */
export function progressPerRank(tierKey: string): number {
  return getTier(tierKey).progress || 0;
}

/**
 * A single number for ordering the league table, highest first.
 *
 * Tier dominates, then rank (1 beats 4), then gauge progress. Rating only separates players
 * inside a rated tier, so a Master Ball 4 on a big rating never outranks a Champion.
 */
export function ladderScore(standing: Standing): number {
  const tier = getTier(standing.tierKey);
  const base = tierIndex(standing.tierKey) * 1_000_000;

  if (tier.ranks === 0) {
    // Champion and Beginner have no sub-ranks; rating separates the Champions.
    return base + Math.min(standing.ratingPoints ?? 0, 999_999);
  }

  // rank counts down, so invert it: rank 1 is worth more than rank 4.
  const rankPart = (tier.ranks - (standing.rank ?? tier.ranks)) * 100_000;
  // Gauges differ in size between tiers, so compare the fraction filled, not the raw count.
  const gauge = tier.progress || 1;
  const progressPart = Math.round((standing.progress / gauge) * 90_000);
  const ratingPart = tier.rated ? Math.min((standing.ratingPoints ?? 0) / 100, 9_999) : 0;
  return base + rankPart + progressPart + ratingPart;
}

/** "Ultra Ball 3", "Master Ball 1", "Champion". */
export function formatStanding(standing: Standing): string {
  const tier = getTier(standing.tierKey);
  if (tier.ranks === 0) return tier.name;
  return `${tier.name} ${standing.rank ?? tier.ranks}`;
}

/** The detail line under the name: gauge, or rating and placement. */
export function formatDetail(standing: Standing): string | null {
  const tier = getTier(standing.tierKey);

  if (tier.rated && standing.ratingPoints !== null) {
    const rating = standing.ratingPoints.toLocaleString('en-US', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
    return standing.globalPlacement !== null
      ? `${rating} pts · top ${standing.globalPlacement.toLocaleString('en-US')}`
      : `${rating} pts`;
  }

  if (tier.ranks === 0) return null;
  return `${standing.progress}/${tier.progress}`;
}

/**
 * Applies a match result to a standing, for the "update as I report" helper.
 *
 * Mirrors the game: a win fills the gauge, a win on a streak fills it faster, a loss drains it.
 * Filling the gauge promotes you a rank, and clearing rank 1 promotes you a tier. Draining it
 * past zero demotes a rank — but never a tier, because the game doesn't demote tiers either.
 *
 * This is only a convenience: whatever the player types in wins, because the game is the
 * authority and these rules are a best guess at it.
 */
export function applyResult(standing: Standing, won: boolean, onStreak = false): Standing {
  const tier = getTier(standing.tierKey);
  if (tier.rated || tier.ranks === 0) return standing; // rated tiers are entered by hand

  const delta = won
    ? LADDER.winProgress + (onStreak ? LADDER.streakBonusProgress : 0)
    : LADDER.lossProgress;

  let rank = standing.rank ?? tier.ranks;
  let progress = standing.progress + delta;
  let tierKey = standing.tierKey;

  while (progress >= progressPerRank(tierKey)) {
    progress -= progressPerRank(tierKey);
    if (rank > 1) {
      rank -= 1;
    } else {
      const next = LADDER.tiers[tierIndex(tierKey) + 1];
      if (!next) return { ...standing, rank: 1, progress: progressPerRank(tierKey) };
      tierKey = next.key;
      rank = next.ranks === 0 ? 1 : next.ranks;
      if (next.rated || next.ranks === 0) {
        return { ...standing, tierKey, rank: next.ranks === 0 ? null : rank, progress: 0 };
      }
    }
  }

  while (progress < 0) {
    // You can lose a rank but never a tier — matching the game's promotion floor.
    if (rank < tier.ranks) {
      rank += 1;
      progress += progressPerRank(tierKey);
    } else {
      progress = 0;
    }
  }

  return { ...standing, tierKey, rank, progress };
}

/** Every rank a player could select, best first — for the standing picker. */
export function allRungs(): { tierKey: string; rank: number | null; label: string }[] {
  const rungs: { tierKey: string; rank: number | null; label: string }[] = [];
  for (const tier of [...LADDER.tiers].reverse()) {
    if (tier.ranks === 0) {
      rungs.push({ tierKey: tier.key, rank: null, label: tier.name });
    } else {
      for (let rank = 1; rank <= tier.ranks; rank += 1) {
        rungs.push({ tierKey: tier.key, rank, label: `${tier.name} ${rank}` });
      }
    }
  }
  return rungs;
}

/**
 * How many discrete rungs a standing sits above the bottom of the ladder.
 * Used to decide how many promotion bonuses to pay when someone jumps several at once.
 */
export function rungNumber(standing: Standing): number {
  let count = 0;
  for (const tier of LADDER.tiers) {
    if (tier.key === standing.tierKey) {
      if (tier.ranks === 0) return count;
      return count + (tier.ranks - (standing.rank ?? tier.ranks));
    }
    count += Math.max(tier.ranks, 1);
  }
  return count;
}
