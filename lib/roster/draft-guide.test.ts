/**
 * The draft guide's arithmetic, and canaries for its role detection.
 *
 * The pure tests run anywhere. The canaries read the PokéAPI cache (`roster:build` fills it, and
 * it is gitignored), so they skip on a fresh clone rather than fail — but wherever the cache
 * exists they are the check that the guide still knows who Incineroar is.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  availableAt,
  basePower,
  kitFromForms,
  ladderRanks,
  medianWhenTaken,
  pickScore,
  qualifiers,
  simulateDraft,
  squadProblems,
  takenShare,
  valueScores,
  type ApiPokemon,
  type GuideMon,
} from './draft-guide.ts';

const api = (moves: Record<string, string[]>, abilities: string[] = []): ApiPokemon => ({
  abilities: abilities.map((name) => ({ ability: { name } })),
  moves: Object.entries(moves).map(([name, groups]) => ({
    move: { name },
    version_group_details: groups.map((g) => ({ version_group: { name: g } })),
  })),
});

const mon = (overrides: Partial<GuideMon> & { moves?: string[]; abilities?: string[] } = {}): GuideMon => {
  const { moves = [], abilities = [], ...rest } = overrides;
  return {
    slug: 'testmon',
    name: 'Testmon',
    tier: 'B',
    price: 50_000,
    rank: 100,
    types: ['Normal'],
    stats: { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
    bst: 480,
    iconUrl: null,
    megas: [],
    kit: { moves: new Set(moves), abilities: new Set(abilities), learnsetFrom: 'champions' },
    ...rest,
  };
};

const rules = qualifiers({ budget: 300_000 });

describe('scores', () => {
  it('maps ladder rank onto 1–10, best first', () => {
    expect(basePower(1, 247)).toBe(10);
    expect(basePower(247, 247)).toBe(1);
    expect(basePower(124, 247)).toBeCloseTo(5.5, 1);
  });

  it('scores the going rate at 5 and a cheaper Pokémon of equal Power higher', () => {
    const values = valueScores([
      { slug: 'strong', power: 9, price: 200_000 },
      { slug: 'weak', power: 3, price: 5_000 },
      { slug: 'bargain', power: 6, price: 10_000 },
      { slug: 'dear', power: 6, price: 100_000 },
    ]);
    expect(values.get('bargain')!).toBeGreaterThan(5);
    expect(values.get('dear')!).toBeLessThan(5);
    expect(values.get('bargain')!).toBeGreaterThan(values.get('dear')!);
  });

  it('gives no Pick to anything over the opening budget', () => {
    expect(pickScore(9.8, 5, 316_000, 300_000)).toBeNull();
    expect(pickScore(8, 6, 180_000, 300_000)).toBe(7.2);
  });
});

describe('ladder ranks', () => {
  it('reads rank from tier-file order, matching regional forms by their full name', () => {
    const entries = [
      { slug: 'arcanine', name: 'Arcanine', form: null, megas: [], alternateForms: [] },
      { slug: 'arcanine-hisui', name: 'Arcanine', form: 'Hisuian Form', megas: [], alternateForms: [] },
      { slug: 'pelipper', name: 'Pelipper', form: null, megas: [], alternateForms: [] },
    ];
    const ranks = ladderRanks(
      { source: 't', updated: 'x', defaultTier: 'UR', tiers: { S: ['Pelipper', 'Hisuian Arcanine'], B: ['Arcanine'] } },
      entries,
    );
    expect(ranks.get('pelipper')).toBe(1);
    expect(ranks.get('arcanine-hisui')).toBe(2);
    expect(ranks.get('arcanine')).toBe(3);
  });
});

describe('learnsets', () => {
  it('prefers Champions, falls back to the newest game, and pools forms', () => {
    const male = api({ 'fake-out': ['champions'], 'trick-room': ['scarlet-violet'] }, ['inner-focus']);
    const female = api({ 'follow-me': ['scarlet-violet'] }, ['psychic-surge']);
    const kit = kitFromForms([male, female]);
    // The male's Champions learnset wins over its own older one…
    expect(kit.moves.has('trick-room')).toBe(false);
    // …but the female's form still contributes, from the best source she has.
    expect(kit.moves.has('follow-me')).toBe(true);
    expect(kit.abilities.has('psychic-surge')).toBe(true);
    expect(kit.learnsetFrom).toBe('champions');
  });
});

describe('role detection', () => {
  it('counts an ability on a Mega, and says so', () => {
    const scrafty = mon({
      megas: [{ slug: 'scrafty-mega', label: 'Mega Scrafty', types: ['Dark'], stats: null, abilities: ['intimidate'] }],
    });
    expect(rules.intimidate(scrafty)).toEqual(['Intimidate (Mega Scrafty)']);
  });

  it('only counts a spread move that gets STAB, or Eruption', () => {
    expect(rules.spread(mon({ types: ['Water'], moves: ['rock-slide'] }))).toEqual([]);
    expect(rules.spread(mon({ types: ['Rock'], moves: ['rock-slide'] }))).toEqual(['Rock Slide']);
    expect(rules.spread(mon({ types: ['Fire', 'Ground'], moves: ['eruption'] }))).toEqual(['Eruption']);
  });

  it('turns Hyper Voice into a spread attack through an -ate Mega', () => {
    const gardevoir = mon({
      types: ['Psychic', 'Fairy'],
      moves: ['hyper-voice'],
      megas: [{ slug: 'g-mega', label: 'Mega Gardevoir', types: ['Psychic', 'Fairy'], stats: null, abilities: ['pixilate'] }],
    });
    expect(rules.spread(gardevoir)).toContain('Fairy Hyper Voice (Mega Gardevoir)');
  });

  it('counts slow heavy hitters, and slow Eruption users, as Trick Room attackers', () => {
    const slowStrong = mon({ stats: { hp: 1, atk: 140, def: 1, spa: 1, spd: 1, spe: 40 } });
    const slowWeak = mon({ stats: { hp: 1, atk: 80, def: 1, spa: 80, spd: 1, spe: 20 } });
    const torkoal = mon({ stats: { hp: 1, atk: 85, def: 1, spa: 85, spd: 1, spe: 20 }, moves: ['eruption'] });
    const fastStrong = mon({ stats: { hp: 1, atk: 140, def: 1, spa: 1, spd: 1, spe: 90 } });
    expect(rules['tr-attackers'](slowStrong)).toHaveLength(1);
    expect(rules['tr-attackers'](slowWeak)).toEqual([]);
    expect(rules['tr-attackers'](torkoal)).toEqual(['Speed 20, Eruption']);
    expect(rules['tr-attackers'](fastStrong)).toEqual([]);
  });

  it("doesn't list a Pokémon as utility for screens alone", () => {
    expect(rules.utility(mon({ moves: ['reflect', 'light-screen'] }))).toEqual([]);
    expect(rules.utility(mon({ moves: ['wide-guard'] }))).toEqual(['Wide Guard']);
  });
});

describe('sample squads', () => {
  const bySlug = new Map([
    ['a', { price: 200_000, megas: [] }],
    ['b', { price: 50_000, megas: [{ slug: 'b-mega', label: 'Mega B', types: [], stats: null, abilities: [] }] }],
    ['c', { price: 10_000, megas: [] }],
  ]);
  const rulesSix = { budget: 300_000, size: 3 };

  it('accepts a squad that fits', () => {
    expect(squadProblems({ name: 's', idea: '', mega: 'b', slugs: ['a', 'b', 'c'] }, bySlug, rulesSix)).toEqual([]);
  });

  it('refuses one over budget, the wrong size, or with a Mega it cannot use', () => {
    const over = squadProblems({ name: 's', idea: '', mega: null, slugs: ['a', 'b', 'c'] }, bySlug, { ...rulesSix, budget: 200_000 });
    expect(over.join()).toMatch(/over the/);
    expect(squadProblems({ name: 's', idea: '', mega: null, slugs: ['a', 'b'] }, bySlug, rulesSix).join()).toMatch(/not 3/);
    expect(squadProblems({ name: 's', idea: '', mega: 'a', slugs: ['a', 'b', 'c'] }, bySlug, rulesSix).join()).toMatch(/no Mega/);
    expect(squadProblems({ name: 's', idea: '', mega: 'z', slugs: ['a', 'b', 'c'] }, bySlug, rulesSix).join()).toMatch(/isn't in/);
  });
});

describe('simulated draft', () => {
  const mons = [
    { slug: 'star', power: 9, price: 200_000 },
    { slug: 'solid', power: 7, price: 60_000 },
    { slug: 'filler1', power: 3, price: 5_000 },
    { slug: 'filler2', power: 2, price: 5_000 },
    { slug: 'dear', power: 10, price: 400_000 },
  ];
  const input = { mons, teams: 2, rounds: 2, budget: 300_000, runs: 20, noise: 0, reservePerPick: 5_000, seed: 1 };

  it('never drafts what nobody can afford, and takes the best affordable first', () => {
    const result = simulateDraft(input);
    expect(takenShare(result, 'dear')).toBe(0);
    expect(medianWhenTaken(result, 'star')).toBe(1);
    expect(availableAt(result, 'star', 2)).toBe(0);
  });

  it('is deterministic for a seed', () => {
    const a = simulateDraft({ ...input, noise: 1 });
    const b = simulateDraft({ ...input, noise: 1 });
    expect([...a.takenAt.entries()]).toEqual([...b.takenAt.entries()]);
  });
});

// Canaries against the real roster. Skipped where the PokéAPI cache hasn't been built.
const hasCache = existsSync(new URL('../../.cache/pokeapi', import.meta.url));

describe.skipIf(!hasCache)('the real guide', async () => {
  const { loadGuide } = await import('../../scripts/guide-model.ts');
  const guide = loadGuide();
  const qualifies = (slug: string, key: string) => Boolean(guide.bySlug.get(slug)?.qualifies[key as never]);

  it('builds: every hand-scored Pokémon exists and qualifies, and every squad fits', () => {
    expect(guide.categories.length).toBeGreaterThan(10);
    for (const squad of guide.squads) expect(squad.total).toBeLessThanOrEqual(guide.budget);
  });

  it('knows the format-defining supports', () => {
    expect(qualifies('incineroar', 'fake-out')).toBe(true);
    expect(qualifies('incineroar', 'intimidate')).toBe(true);
    expect(qualifies('whimsicott', 'tailwind')).toBe(true);
    expect(qualifies('torkoal', 'sun')).toBe(true);
    expect(qualifies('pelipper', 'rain')).toBe(true);
    // Only the female learns Follow Me: this fails if forms stop being pooled.
    expect(qualifies('indeedee', 'redirection')).toBe(true);
    expect(qualifies('indeedee', 'terrain')).toBe(true);
  });

  it('prices every S-tier out of the draft', () => {
    for (const m of guide.mons.filter((x) => x.tier === 'S')) expect(m.pick).toBeNull();
  });
});
