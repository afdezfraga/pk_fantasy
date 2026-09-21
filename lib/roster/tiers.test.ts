import { describe, expect, it } from 'vitest';

import { computeBaseValue, LEAGUE_DEFAULTS, TIER_PRICE_BANDS, TIERS } from '../../config/economy.ts';
import { assetAliases, normalizeName, resolveTiers, type NameableEntry, type TierFile } from './tiers.ts';

const charizard: NameableEntry = {
  slug: 'charizard',
  name: 'Charizard',
  form: null,
  megas: [
    { slug: 'charizard-mega-x', label: 'Mega Charizard X' },
    { slug: 'charizard-mega-y', label: 'Mega Charizard Y' },
  ],
  alternateForms: [],
};

const alolanNinetales: NameableEntry = {
  slug: 'ninetales-alola',
  name: 'Ninetales',
  form: 'Alolan Form',
  megas: [],
  alternateForms: [],
};

const rotom: NameableEntry = {
  slug: 'rotom',
  name: 'Rotom',
  form: null,
  megas: [],
  alternateForms: [
    { slug: 'rotom-wash', label: 'Wash Rotom' },
    { slug: 'rotom-heat', label: 'Heat Rotom' },
  ],
};

const floette: NameableEntry = {
  slug: 'floette-eternal',
  name: 'Floette',
  form: 'Eternal Flower',
  megas: [{ slug: 'floette-mega', label: 'Mega Floette' }],
  alternateForms: [],
};

const roster = [charizard, alolanNinetales, rotom, floette];

function tierFile(overrides: Partial<TierFile> = {}): TierFile {
  return {
    source: 'test',
    updated: '2026-09-11',
    defaultTier: 'UR',
    tiers: {},
    ...overrides,
  };
}

describe('normalizeName', () => {
  it('ignores case, punctuation and form-word noise', () => {
    expect(normalizeName('Basculegion (Male)')).toBe(normalizeName('Basculegion'));
    expect(normalizeName('Aegislash (Shield Forme)')).toBe(normalizeName('Aegislash Shield'));
    expect(normalizeName("Farfetch'd")).toBe('farfetchd');
  });
});

describe('assetAliases', () => {
  it('offers both word orders for a regional form', () => {
    const aliases = assetAliases(alolanNinetales).map(normalizeName);
    expect(aliases).toContain(normalizeName('Alolan Ninetales'));
    expect(aliases).toContain(normalizeName('Ninetales Alolan'));
  });

  it('lets an alternate form stand in for its owner', () => {
    // Alternate forms aren't separately tradable, so a tier for Wash Rotom is a tier for Rotom.
    expect(assetAliases(rotom).map(normalizeName)).toContain(normalizeName('Wash Rotom'));
  });
});

describe('resolveTiers', () => {
  it('matches display names onto asset slugs', () => {
    const { bySlug, unmatched } = resolveTiers(
      tierFile({ tiers: { S: ['Alolan Ninetales', 'Wash Rotom', 'Eternal Flower Floette'] } }),
      roster,
    );
    expect(bySlug.get('ninetales-alola')).toBe('S');
    expect(bySlug.get('rotom')).toBe('S');
    expect(bySlug.get('floette-eternal')).toBe('S');
    expect(unmatched).toEqual([]);
  });

  it('routes Mega names to the Mega, not the species', () => {
    const { bySlug, byMegaSlug } = resolveTiers(
      tierFile({ tiers: { A: ['Mega Charizard Y'] } }),
      roster,
    );
    expect(byMegaSlug.get('charizard-mega-y')).toBe('A');
    expect(bySlug.has('charizard')).toBe(false);
  });

  it('reads a dedicated megaTiers block and skips its _comment key', () => {
    const { byMegaSlug, unmatched } = resolveTiers(
      tierFile({ megaTiers: { _comment: 'ignore me', S: ['Mega Floette'] } }),
      roster,
    );
    expect(byMegaSlug.get('floette-mega')).toBe('S');
    expect(unmatched).toEqual([]);
  });

  // The whole point of reporting rather than ignoring: a typo must not silently make a
  // Pokémon cheap for a whole season.
  it('reports names that match nothing instead of dropping them', () => {
    const { unmatched } = resolveTiers(tierFile({ tiers: { S: ['Charizrd'] } }), roster);
    expect(unmatched).toEqual(['Charizrd (S)']);
  });
});

describe('computeBaseValue', () => {
  it('prices by tier', () => {
    const s = computeBaseValue({ tier: 'S', effectiveBst: 525 });
    const d = computeBaseValue({ tier: 'D', effectiveBst: 525 });
    expect(s).toBeGreaterThan(d);
  });

  it('keeps every tier inside its price band', () => {
    for (const tier of TIERS) {
      for (const bst of [300, 400, 525, 650, 780]) {
        const price = computeBaseValue({ tier, effectiveBst: bst });
        expect(price).toBeGreaterThanOrEqual(TIER_PRICE_BANDS[tier][0]);
        expect(price).toBeLessThanOrEqual(TIER_PRICE_BANDS[tier][1]);
      }
    }
  });

  // The cheapest S-tier costs the whole opening budget — affordable, but only just.
  it('starts S tier at the opening budget', () => {
    expect(computeBaseValue({ tier: 'S', effectiveBst: 300 })).toBe(LEAGUE_DEFAULTS.startingCash);
  });

  it('spreads Pokémon within a tier by stats', () => {
    const weak = computeBaseValue({ tier: 'A', effectiveBst: 400 });
    const strong = computeBaseValue({ tier: 'A', effectiveBst: 650 });
    expect(strong).toBeGreaterThan(weak);
    // ...but never enough to jump a tier.
    expect(strong).toBeLessThan(computeBaseValue({ tier: 'A+', effectiveBst: 400 }));
  });

  it('prices unranked Pokémon on stats so strong ones are not free money', () => {
    // Palafin is unranked but transforms into a 650-BST Hero form. A flat floor price would
    // make it an exploit; it should instead cost several times the filler.
    const palafin = computeBaseValue({ tier: 'UR', effectiveBst: 650 });
    const filler = computeBaseValue({ tier: 'UR', effectiveBst: 400 });
    expect(palafin).toBeGreaterThan(filler * 3);
  });

  it('rounds to a readable increment', () => {
    for (const bst of [400, 455, 512, 587, 650]) {
      expect(computeBaseValue({ tier: 'B', effectiveBst: bst }) % 1_000).toBe(0);
    }
  });
});
