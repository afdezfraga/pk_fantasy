/**
 * Turning what you tapped into a match score.
 *
 * Every match is a Champions ladder game, so the only thing a player really knows afterwards is
 * whether they won and what each of their Pokémon did. Asking them to also type a scoreline is
 * asking twice for the same information: a doubles match ends when one side is out of Pokémon, so
 * the KOs you landed and the Pokémon of yours that fainted *are* the score.
 *
 * Pure, and shared by the report form's live preview and the server action that saves it, so the
 * number on screen and the number in the ledger can't disagree.
 */

/** Stored as the opponent for every match, since they're all anonymous ladder games. */
export const LADDER_OPPONENT = 'Ranked ladder';

export interface ScoreLine {
  kos: number;
  fainted: boolean;
}

export function deriveScore(input: { won: boolean; lines: ScoreLine[] }): {
  homeScore: number;
  awayScore: number;
} {
  const dealt = input.lines.reduce((sum, line) => sum + line.kos, 0);
  const conceded = input.lines.filter((line) => line.fainted).length;

  // The winner always has to be ahead. `reportMatch` refuses a level score, and the honest
  // numbers really can tie — win a match 4 KOs to 4 losses and the raw counts read 4–4 — so the
  // winning side is nudged clear rather than the whole report being rejected.
  return input.won
    ? { homeScore: Math.max(dealt, conceded + 1), awayScore: conceded }
    : { homeScore: dealt, awayScore: Math.max(conceded, dealt + 1) };
}
