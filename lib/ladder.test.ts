import { describe, expect, it } from 'vitest';

import {
  applyResult,
  formatDetail,
  formatStanding,
  ladderScore,
  progressPerRank,
  rungNumber,
  type Standing,
} from './ladder.ts';

const at = (tierKey: string, rank: number | null, progress = 0): Standing => ({
  tierKey,
  rank,
  progress,
  ratingPoints: null,
  globalPlacement: null,
});

describe('progressPerRank', () => {
  // The gauge is not the same size in every tier — climbing gets harder as you go up.
  it('differs per tier', () => {
    expect(progressPerRank('poke')).toBe(3);
    expect(progressPerRank('great')).toBe(4);
    expect(progressPerRank('ultra')).toBe(5);
  });
});

describe('formatting', () => {
  it('names a rank the way the game does', () => {
    expect(formatStanding(at('ultra', 3))).toBe('Ultra Ball 3');
    expect(formatStanding(at('champion', null))).toBe('Champion');
  });

  it('shows the gauge out of that tier’s own total', () => {
    expect(formatDetail(at('ultra', 3, 3))).toBe('3/5');
    expect(formatDetail(at('poke', 2, 1))).toBe('1/3');
    expect(formatDetail(at('great', 1, 4))).toBe('4/4');
  });

  it('shows rating and placement in a rated tier', () => {
    expect(
      formatDetail({
        tierKey: 'master',
        rank: 4,
        progress: 0,
        ratingPoints: 1703.462,
        globalPlacement: 123329,
      }),
    ).toBe('1,703.462 pts · top 123,329');
  });
});

describe('ladderScore', () => {
  it('puts a higher tier above a better rank in a lower tier', () => {
    // Ultra Ball 4 (bottom of Ultra) still beats Great Ball 1 (top of Great).
    expect(ladderScore(at('ultra', 4))).toBeGreaterThan(ladderScore(at('great', 1)));
  });

  it('ranks 1 above 4 inside a tier', () => {
    expect(ladderScore(at('ultra', 1))).toBeGreaterThan(ladderScore(at('ultra', 4)));
  });

  it('uses progress to separate equal ranks', () => {
    expect(ladderScore(at('ultra', 3, 4))).toBeGreaterThan(ladderScore(at('ultra', 3, 1)));
  });

  it('compares gauges as a fraction, since tiers have different sizes', () => {
    // 2/3 of a Poké Ball gauge is more progress than 2/5 of an Ultra Ball one, even though the
    // raw numbers match — so comparing raw counts would be wrong.
    const pokeTwoThirds = ladderScore(at('poke', 2, 2)) - ladderScore(at('poke', 2, 0));
    const ultraTwoFifths = ladderScore(at('ultra', 2, 2)) - ladderScore(at('ultra', 2, 0));
    expect(pokeTwoThirds).toBeGreaterThan(ultraTwoFifths);
  });

  it('puts Champion above everything', () => {
    expect(ladderScore(at('champion', null))).toBeGreaterThan(ladderScore(at('master', 1, 5)));
  });
});

describe('applyResult', () => {
  it('fills the gauge on a win', () => {
    expect(applyResult(at('ultra', 3, 2), true)).toMatchObject({ rank: 3, progress: 3 });
  });

  it('fills faster on a streak', () => {
    expect(applyResult(at('ultra', 3, 2), true, true)).toMatchObject({ progress: 4 });
  });

  it('drains on a loss', () => {
    expect(applyResult(at('ultra', 3, 2), false)).toMatchObject({ rank: 3, progress: 1 });
  });

  it('promotes a rank when the gauge fills', () => {
    // Ultra Ball takes 5, so 4 + 1 clears it.
    expect(applyResult(at('ultra', 3, 4), true)).toMatchObject({ rank: 2, progress: 0 });
  });

  it('uses the tier’s own gauge size to promote', () => {
    // Poké Ball only takes 3.
    expect(applyResult(at('poke', 3, 2), true)).toMatchObject({ rank: 2, progress: 0 });
  });

  it('promotes a tier after clearing rank 1', () => {
    const promoted = applyResult(at('great', 1, 3), true);
    expect(promoted.tierKey).toBe('ultra');
    expect(promoted.rank).toBe(4);
  });

  it('demotes a rank but never a tier', () => {
    // The game never drops you out of a tier you've reached.
    const bottomOfUltra = at('ultra', 4, 0);
    expect(applyResult(bottomOfUltra, false)).toMatchObject({ tierKey: 'ultra', rank: 4, progress: 0 });
  });

  it('leaves rated tiers alone, since those are typed in by hand', () => {
    const master: Standing = {
      tierKey: 'master',
      rank: 4,
      progress: 0,
      ratingPoints: 1703.462,
      globalPlacement: 123329,
    };
    expect(applyResult(master, true)).toEqual(master);
  });
});

describe('rungNumber', () => {
  it('increases as you climb', () => {
    expect(rungNumber(at('ultra', 3))).toBeGreaterThan(rungNumber(at('great', 3)));
    expect(rungNumber(at('ultra', 1))).toBeGreaterThan(rungNumber(at('ultra', 4)));
  });

  it('starts at zero for a brand-new player', () => {
    expect(rungNumber(at('beginner', null))).toBe(0);
  });
});
