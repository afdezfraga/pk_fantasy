import { describe, expect, it } from 'vitest';

import {
  assetKey,
  interpretAvailability,
  parentFormCode,
  parseRow,
  parseSection,
  splitSections,
  toPokeApiSlug,
  toSlug,
} from './parse.ts';

describe('parseRow', () => {
  it('parses a plain two-type row', () => {
    expect(parseRow('{{gdex/Champs|0003|Venusaur|2|Grass|Poison|Yes|1.0.2}}')).toEqual({
      dex: 3,
      name: 'Venusaur',
      ig: null,
      form: null,
      types: ['Grass', 'Poison'],
      available: 'Yes',
      versionAdded: '1.0.2',
    });
  });

  it('parses a single-type row', () => {
    const row = parseRow('{{gdex/Champs|0009|Blastoise|1|Water|Yes|1.0.2}}');
    expect(row?.types).toEqual(['Water']);
    expect(row?.versionAdded).toBe('1.0.2');
  });

  it('parses named form parameters in any position', () => {
    const row = parseRow(
      '{{gdex/Champs|0026|Raichu|2|Electric|Psychic|ig=-Alola|form=Alolan Form|Yes|1.0.2}}',
    );
    expect(row).toMatchObject({ dex: 26, ig: '-Alola', form: 'Alolan Form', available: 'Yes' });
  });

  it('strips tooltip templates that leak into the version cell', () => {
    // `{{tt|1.0.2|note}}` splits on `|` and leaves `1.0.2{{tt` in the positional slot.
    const row = parseRow('{{gdex/Champs|0059|Arcanine|1|Fire|Yes|1.0.2{{tt|a|b}}}}');
    expect(row?.versionAdded).toBe('1.0.2');
  });

  it('ignores lines that are not roster rows', () => {
    expect(parseRow('{{gdexh/Champs}}')).toBeNull();
    expect(parseRow('Some prose about the roster.')).toBeNull();
    expect(parseRow('')).toBeNull();
  });
});

describe('splitSections', () => {
  it('separates sections and tolerates the page’s ragged headings', () => {
    // The live page really does write `==Forms===` and `==Mega Evolutions====`.
    const sections = splitSections(['intro line', '==Forms===', 'a', '====Mega Evolutions====', 'b'].join('\n'));
    expect(sections.get('intro')).toEqual(['intro line']);
    expect(sections.get('Forms')).toEqual(['a']);
    expect(sections.get('Mega Evolutions')).toEqual(['b']);
  });

  it('collects only roster rows from a section', () => {
    const rows = parseSection([
      '{{gdexh/Champs}}',
      '{{gdex/Champs|0003|Venusaur|2|Grass|Poison|Yes|1.0.2}}',
      'prose',
      '{{gdex/Champs|0009|Blastoise|1|Water|Yes|1.0.2}}',
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Venusaur', 'Blastoise']);
  });
});

describe('interpretAvailability', () => {
  it('treats a plain yes as freely available', () => {
    expect(interpretAvailability('Yes')).toEqual({ legal: true, restricted: false, notes: null });
  });

  it('keeps the caveat on a qualified yes', () => {
    // Pikachu: the only non-fully-evolved Pokémon in the game.
    expect(interpretAvailability('Yes<br>(Regular form only)')).toEqual({
      legal: true,
      restricted: false,
      notes: 'Regular form only',
    });
  });

  it('marks a transfer-only Pokémon restricted, not illegal', () => {
    // Eternal Flower Floette has to come from another game, but it is on the Champions roster
    // and battles like anything else — so it belongs in the league, flagged.
    expect(interpretAvailability('Transfer only')).toEqual({
      legal: true,
      restricted: true,
      notes: 'Transfer only',
    });
  });

  it('marks an event-only form restricted too', () => {
    // Mega Floette, the only Mega with a caveat of its own.
    expect(interpretAvailability('Event only')).toEqual({
      legal: true,
      restricted: true,
      notes: 'Event only',
    });
  });
});

describe('toSlug', () => {
  it('builds readable identities', () => {
    expect(toSlug('Venusaur', null)).toBe('venusaur');
    expect(toSlug('Raichu', '-Alola')).toBe('raichu-alola');
    expect(toSlug('Charizard', '-Mega X')).toBe('charizard-mega-x');
    expect(toSlug('Arcanine', '-Hisui')).toBe('arcanine-hisui');
  });

  it('drops apostrophes rather than turning them into hyphens', () => {
    expect(toSlug("Farfetch'd", null)).toBe('farfetchd');
    expect(toSlug("Sirfetch'd", null)).toBe('sirfetchd');
  });

  it('keeps PokéAPI naming out of the public identity', () => {
    // Palafin's PokéAPI entry is `palafin-zero`, but that must not reach our URLs.
    expect(toSlug('Palafin', null)).toBe('palafin');
    expect(toPokeApiSlug('Palafin', null)).toBe('palafin-zero');
    expect(toPokeApiSlug('Aegislash', null)).toBe('aegislash-shield');
    expect(toPokeApiSlug('Venusaur', null)).toBe('venusaur');
  });
});

describe('parentFormCode', () => {
  it('strips every Mega variant letter, including Z-A’s third one', () => {
    expect(parentFormCode('-Mega')).toBeNull();
    expect(parentFormCode('-Mega X')).toBeNull();
    expect(parentFormCode('-Mega Y')).toBeNull();
    // Legends: Z-A added Mega Garchomp Z — an earlier X|Y-only rule silently orphaned these.
    expect(parentFormCode('-Mega Z')).toBeNull();
  });

  it('keeps the regional part of a regional Mega', () => {
    expect(parentFormCode('-Alola-Mega')).toBe('-Alola');
  });

  it('passes a plain regional form through', () => {
    expect(parentFormCode('-Hisui')).toBe('-Hisui');
    expect(parentFormCode(null)).toBeNull();
  });
});

describe('assetKey', () => {
  it('distinguishes a regional form from its base species', () => {
    expect(assetKey(26, null)).not.toBe(assetKey(26, '-Alola'));
  });
});
