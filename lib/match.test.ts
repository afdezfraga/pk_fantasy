import { describe, expect, it } from 'vitest';

import { deriveScore } from './match.ts';

const line = (kos: number, fainted = false) => ({ kos, fainted });

describe('deriveScore', () => {
  it('reads the score straight off the lines', () => {
    // Four KOs landed, one of yours down.
    expect(deriveScore({ won: true, lines: [line(2), line(2), line(0, true), line(0)] })).toEqual({
      homeScore: 4,
      awayScore: 1,
    });
  });

  it('puts the winner ahead even when the raw counts tie', () => {
    // A 4-KO win where all four of yours also fainted is a real result, and 4–4 would be
    // rejected as a draw.
    const score = deriveScore({
      won: true,
      lines: [line(1, true), line(1, true), line(1, true), line(1, true)],
    });
    expect(score.homeScore).toBeGreaterThan(score.awayScore);
    expect(score.awayScore).toBe(4);
  });

  it('puts the loser behind even when the raw counts tie', () => {
    const score = deriveScore({
      won: false,
      lines: [line(1, true), line(1, true), line(1, true), line(1, true)],
    });
    expect(score.awayScore).toBeGreaterThan(score.homeScore);
    expect(score.homeScore).toBe(4);
  });

  it('scores a win with no KOs entered as 1–0', () => {
    // Someone who can't be bothered with the detail still gets a valid, winning result.
    expect(deriveScore({ won: true, lines: [line(0)] })).toEqual({ homeScore: 1, awayScore: 0 });
  });

  it('scores a loss with nothing entered as 0–1', () => {
    expect(deriveScore({ won: false, lines: [line(0)] })).toEqual({ homeScore: 0, awayScore: 1 });
  });

  it('keeps a loss behind even when you landed more KOs than you lost Pokémon', () => {
    // You can lose on time or on a forfeit having dealt more damage.
    const score = deriveScore({ won: false, lines: [line(3), line(0, true)] });
    expect(score.awayScore).toBeGreaterThan(score.homeScore);
  });

  it('never returns a draw', () => {
    for (const won of [true, false]) {
      for (let kos = 0; kos <= 4; kos += 1) {
        for (let down = 0; down <= 4; down += 1) {
          const lines = Array.from({ length: 4 }, (_, i) => line(i === 0 ? kos : 0, i < down));
          const score = deriveScore({ won, lines });
          expect(score.homeScore).not.toBe(score.awayScore);
          expect(score.homeScore > score.awayScore).toBe(won);
        }
      }
    }
  });
});
