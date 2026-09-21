/**
 * How a battle turns into fantasy points and money.
 *
 * Points are computed at report time and stored on the row, so changing these numbers doesn't
 * silently rewrite the history of matches already played.
 */

export const SCORING = {
  /** Per Pokémon. */
  koLanded: 8,
  fainted: -3,
  /** Came out of the match alive. */
  survived: 4,
  /** Brought but never sent out. */
  benched: 0,

  /** Per team. */
  matchWin: 25,
  matchLoss: 0,
  /** Won without losing a single Pokémon. */
  cleanSweep: 15,
  /** Beat a team whose squad is worth more than yours. */
  upset: 10,
} as const;

/**
 * Money comes from winning, and only from winning. A loss pays nothing.
 *
 * The reward depends on the ladder tier the win came in (data/ranks.json keys), and a winning
 * streak multiplies it — the whole economy is built so that climbing and staying hot is what
 * pays for the top of the market.
 */
export const PAYOUTS = {
  winReward: {
    beginner: 1_000,
    poke: 1_000,
    great: 2_000,
    ultra: 10_000,
    master: 25_000,
    champion: 100_000,
  } as Record<string, number>,

  /** Streak multipliers, highest threshold first: from the 5th straight win ×5, from the 3rd ×3. */
  streakMultipliers: [
    { from: 5, times: 5 },
    { from: 3, times: 3 },
  ],

  /**
   * Matches per round that actually pay out.
   *
   * Everyone grinds the ladder separately, so one player might log forty matches in a week and
   * another five. Without a ceiling the heavy grinder simply out-earns everyone and buys the
   * market. Beyond this many, matches still count for ladder progress, streaks and a Pokémon's
   * value — they just stop paying.
   */
  paidMatchesPerRound: 10,
} as const;

/** Multiplier for a win that makes the streak this long (the win itself included). */
export function streakMultiplier(streak: number): number {
  return PAYOUTS.streakMultipliers.find((step) => streak >= step.from)?.times ?? 1;
}

/** What a win pays in this ladder tier at this streak. */
export function winReward(tierKey: string, streak: number): number {
  return (PAYOUTS.winReward[tierKey] ?? 0) * streakMultiplier(streak);
}

export interface PokemonLine {
  pokemonSlug: string;
  kos: number;
  fainted: boolean;
  benched: boolean;
}

export function scorePokemon(line: PokemonLine): number {
  if (line.benched) return SCORING.benched;
  return line.kos * SCORING.koLanded + (line.fainted ? SCORING.fainted : SCORING.survived);
}

export interface TeamScoreInput {
  lines: PokemonLine[];
  won: boolean;
  /** Whether this team's squad is worth less than the opponent's. */
  underdog: boolean;
  /** Consecutive wins including this match. */
  streak: number;
  /** Ladder tier the match was played in — sets the reward. */
  tierKey: string;
}

export interface TeamScore {
  pokemonPoints: number;
  bonusPoints: number;
  totalPoints: number;
  money: number;
  breakdown: { label: string; points?: number; money?: number }[];
}

export function scoreTeam(input: TeamScoreInput): TeamScore {
  const pokemonPoints = input.lines.reduce((sum, line) => sum + scorePokemon(line), 0);
  const breakdown: TeamScore['breakdown'] = [];

  let bonusPoints = 0;
  if (input.won) {
    bonusPoints += SCORING.matchWin;
    breakdown.push({ label: 'Match win', points: SCORING.matchWin });

    const played = input.lines.filter((line) => !line.benched);
    if (played.length > 0 && played.every((line) => !line.fainted)) {
      bonusPoints += SCORING.cleanSweep;
      breakdown.push({ label: 'Clean sweep', points: SCORING.cleanSweep });
    }
    if (input.underdog) {
      bonusPoints += SCORING.upset;
      breakdown.push({ label: 'Upset', points: SCORING.upset });
    }
  }

  const totalPoints = pokemonPoints + bonusPoints;

  // Points are for the stats and awards; money is the tier's win reward and nothing else.
  let money = 0;
  if (input.won) {
    const base = PAYOUTS.winReward[input.tierKey] ?? 0;
    const times = streakMultiplier(input.streak);
    money = base * times;
    breakdown.push({ label: 'Win reward', money: base });
    if (times > 1) {
      breakdown.push({ label: `${input.streak}-win streak ×${times}`, money: money - base });
    }
  }

  return { pokemonPoints, bonusPoints, totalPoints, money, breakdown };
}
