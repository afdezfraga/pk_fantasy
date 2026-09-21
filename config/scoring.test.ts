import { describe, expect, it } from 'vitest';

import { PAYOUTS, SCORING, scorePokemon, scoreTeam, streakMultiplier, winReward } from './scoring.ts';

const line = (kos: number, fainted = false, benched = false) => ({
  pokemonSlug: 'x',
  kos,
  fainted,
  benched,
});

describe('scorePokemon', () => {
  it('rewards KOs and surviving', () => {
    expect(scorePokemon(line(2))).toBe(2 * SCORING.koLanded + SCORING.survived);
  });

  it('penalises fainting', () => {
    expect(scorePokemon(line(0, true))).toBe(SCORING.fainted);
  });

  it('scores a benched Pokémon at nothing, not at a survival bonus', () => {
    // Sitting on the bench must not pay the same as surviving a match.
    expect(scorePokemon(line(0, false, true))).toBe(SCORING.benched);
  });
});

describe('scoreTeam', () => {
  const base = { won: true, underdog: false, streak: 1, tierKey: 'ultra' };

  it('adds the win bonus', () => {
    const result = scoreTeam({ ...base, lines: [line(1)] });
    expect(result.bonusPoints).toBeGreaterThanOrEqual(SCORING.matchWin);
  });

  it('pays a clean sweep when nothing fainted', () => {
    const swept = scoreTeam({ ...base, lines: [line(2), line(1)] });
    const bloodied = scoreTeam({ ...base, lines: [line(2), line(1, true)] });
    expect(swept.bonusPoints - bloodied.bonusPoints).toBe(SCORING.cleanSweep);
  });

  it('does not count a benched Pokémon against a clean sweep', () => {
    const result = scoreTeam({ ...base, lines: [line(2), line(0, false, true)] });
    expect(result.breakdown.some((row) => row.label === 'Clean sweep')).toBe(true);
  });

  it('pays an upset bonus to the cheaper squad', () => {
    const upset = scoreTeam({ ...base, underdog: true, lines: [line(1)] });
    const expected = scoreTeam({ ...base, underdog: false, lines: [line(1)] });
    expect(upset.bonusPoints - expected.bonusPoints).toBe(SCORING.upset);
  });

  it('pays a loser nothing, however well it played', () => {
    const lost = scoreTeam({
      lines: [line(3)],
      won: false,
      underdog: false,
      streak: 0,
      tierKey: 'champion',
    });
    expect(lost.totalPoints).toBeGreaterThan(0);
    expect(lost.money).toBe(0);
  });

  it('pays the win reward of the tier the match was played in', () => {
    expect(scoreTeam({ ...base, tierKey: 'poke', lines: [line(1)] }).money).toBe(1_000);
    expect(scoreTeam({ ...base, tierKey: 'ultra', lines: [line(1)] }).money).toBe(10_000);
    expect(scoreTeam({ ...base, tierKey: 'champion', lines: [line(1)] }).money).toBe(100_000);
  });

  it('does not let points change the money', () => {
    const quiet = scoreTeam({ ...base, lines: [line(0, true)] });
    const rampage = scoreTeam({ ...base, lines: [line(4), line(3)] });
    expect(rampage.money).toBe(quiet.money);
  });

  it('multiplies the reward on a winning streak', () => {
    const at = (streak: number) => scoreTeam({ ...base, streak, lines: [line(1)] }).money;
    expect(at(2)).toBe(PAYOUTS.winReward.ultra);
    expect(at(3)).toBe(PAYOUTS.winReward.ultra * 3);
    expect(at(4)).toBe(PAYOUTS.winReward.ultra * 3);
    expect(at(5)).toBe(PAYOUTS.winReward.ultra * 5);
    expect(at(8)).toBe(PAYOUTS.winReward.ultra * 5);
  });

  it('pays whole Pokédollars, so the ledger stays exact', () => {
    const result = scoreTeam({ ...base, lines: [line(3), line(1, true)] });
    expect(Number.isInteger(result.money)).toBe(true);
  });
});

describe('streakMultiplier', () => {
  it('is ×1 below three, ×3 from the third win and ×5 from the fifth', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(streakMultiplier)).toEqual([1, 1, 1, 3, 3, 5, 5]);
  });

  it('pays nothing for an unknown tier', () => {
    expect(winReward('nowhere', 5)).toBe(0);
  });
});
