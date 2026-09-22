/**
 * Parser for the Bulbapedia "List of Pokémon in Pokémon Champions" wikitext.
 *
 * Every roster row is a single template call:
 *
 *   {{gdex/Champs|0003|Venusaur|2|Grass|Poison|Yes|1.0.2}}
 *   {{gdex/Champs|0026|Raichu|2|Electric|Psychic|ig=-Alola|form=Alolan Form|Yes|1.0.2}}
 *   {{gdex/Champs|0006|Charizard|2|Fire|Dragon|ig=-Mega X|form=Mega Charizard X|Yes|1.0.2}}
 *
 * Positionally: dex, name, typeCount, type × typeCount, availability, versionAdded — with
 * optional named `ig=` (form code) and `form=` (label) params appearing anywhere in between.
 *
 * Pure functions only; no fetching. See `scripts/build-roster.ts` for the network side.
 */

export const SECTION_MAIN = 'List of Pokémon in Champions';
export const SECTION_MEGA = 'Mega Evolutions';
export const SECTION_OTHER = 'Other forms';

export interface RawRow {
  dex: number;
  name: string;
  /** Form code as written on the wiki, e.g. "-Alola", "-Mega X". Null for the base species. */
  ig: string | null;
  /** Human label, e.g. "Alolan Form", "Mega Charizard X". */
  form: string | null;
  types: string[];
  /** Raw availability cell, e.g. "Yes", "Transfer only", "Yes<br>(Regular form only)". */
  available: string;
  versionAdded: string;
}

/** Splits wikitext into `{ sectionTitle: lines }`. Handles the page's ragged `==Foo===` headings. */
export function splitSections(wikitext: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = 'intro';
  sections.set(current, []);

  for (const line of wikitext.split('\n')) {
    const heading = /^=+\s*([^=]+?)\s*=+\s*$/.exec(line);
    if (heading) {
      current = heading[1].trim();
      if (!sections.has(current)) sections.set(current, []);
    } else {
      sections.get(current)!.push(line);
    }
  }
  return sections;
}

/** Strips `{{tt|a|b}}`-style templates and HTML tags that ride along in table cells. */
function stripMarkup(value: string): string {
  return value
    .replace(/\{\{[^{}]*\}?\}?/g, '') // tooltip templates, possibly unbalanced after the split
    .replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, '$1') // wiki links → label
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses one `{{gdex/Champs|...}}` line. Returns null for any other line.
 *
 * Note the template args are split on `|` only — nested templates in the version cell
 * (`1.0.2{{tt|...|...}}`) would break that, so we re-join stray fragments by requiring the
 * positional count to line up and treating the remainder as trailing noise.
 */
export function parseRow(line: string): RawRow | null {
  const match = /^\{\{gdex\/Champs\|(.+?)\}\}\s*$/.exec(line.trim());
  if (!match) return null;

  const positional: string[] = [];
  let ig: string | null = null;
  let form: string | null = null;

  for (const part of match[1].split('|')) {
    const named = /^(ig|form)=(.*)$/s.exec(part);
    if (named) {
      if (named[1] === 'ig') ig = named[2].trim() || null;
      // The wiki writes multi-line form labels with a literal <br> ("Paldean Form<br>(Aqua
      // Breed)"). Left in, it reaches the UI verbatim and defeats tier-list name matching,
      // which strips punctuation and would read the tag as the word "br".
      else form = named[2].replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim() || null;
    } else {
      positional.push(part);
    }
  }

  if (positional.length < 4) return null;

  const dex = Number.parseInt(positional[0], 10);
  const name = positional[1].trim();
  const typeCount = Number.parseInt(positional[2], 10);
  if (!Number.isFinite(dex) || !Number.isFinite(typeCount)) return null;

  const types = positional.slice(3, 3 + typeCount).map((t) => t.trim());
  const rest = positional.slice(3 + typeCount);

  return {
    dex,
    name,
    ig,
    form,
    types,
    available: (rest[0] ?? '').trim(),
    versionAdded: stripMarkup(rest[1] ?? ''),
  };
}

export function parseSection(lines: string[]): RawRow[] {
  return lines.map(parseRow).filter((row): row is RawRow => row !== null);
}

/**
 * Interprets the availability cell.
 *
 * Observed values: "Yes", "Yes<br>(Regular form only)", "Transfer only", "Event only".
 *
 * Two different things are being said here, and conflating them was a bug: whether a Pokémon is
 * *on the Champions roster* (`legal`), and whether you can *obtain one freely in the game*
 * (`restricted`). Eternal Flower Floette is roster-legal — it battles like anything else — but
 * has to be transferred in from another game. Treating that as illegal hid it from the league
 * entirely, which is not what the source says.
 *
 * `legal` therefore stays true for everything the page lists; a rotation that drops a Pokémon
 * from the roster is what sets it false (see scripts/seed.ts).
 */
export function interpretAvailability(available: string): {
  legal: boolean;
  restricted: boolean;
  notes: string | null;
} {
  const text = stripMarkup(available);
  const parenthetical = /\(([^)]+)\)/.exec(text);
  const notes = parenthetical ? parenthetical[1].trim() : null;
  const freelyAvailable = /^yes\b/i.test(text);
  return {
    legal: true,
    restricted: !freelyAvailable,
    notes: freelyAvailable ? notes : (notes ?? (text || null)),
  };
}

/**
 * Form codes that don't follow the `name + ig` → PokéAPI slug rule.
 *
 * Three causes, all confirmed against the live API:
 *  - apostrophes in names (`Farfetch'd`);
 *  - Pokémon whose PokéAPI *default* entry is itself a named form (`aegislash-shield`);
 *  - form codes the wiki and PokéAPI spell differently (`tauros-paldea-combat-breed`).
 */
export const SLUG_ALIASES: Record<string, string> = {
  // PokéAPI has no bare species entry; the default form carries a suffix.
  aegislash: 'aegislash-shield',
  basculegion: 'basculegion-male',
  gourgeist: 'gourgeist-average',
  indeedee: 'indeedee-male',
  lycanroc: 'lycanroc-midday',
  maushold: 'maushold-family-of-four',
  meowstic: 'meowstic-male',
  mimikyu: 'mimikyu-disguised',
  morpeko: 'morpeko-full-belly',
  palafin: 'palafin-zero',
  pyroar: 'pyroar-male',
  squawkabilly: 'squawkabilly-green-plumage',
  toxtricity: 'toxtricity-amped',

  // Spelling differences.
  'tauros-paldea-combat': 'tauros-paldea-combat-breed',
  'tauros-paldea-blaze': 'tauros-paldea-blaze-breed',
  'tauros-paldea-aqua': 'tauros-paldea-aqua-breed',
  // Vivillon's patterns are cosmetic and PokéAPI only models a few; use the base entry.
  'vivillon-high-plains': 'vivillon',
  // Eternal Flower Floette is `floette-eternal`, not `floette-eternal-flower`.
  'floette-eternal-flower': 'floette-eternal',
  'darmanitan-galar': 'darmanitan-galar-standard',
};

/**
 * The Pokémon's identity in this app: lowercase, spaces to hyphens, diacritics stripped.
 * `Charizard` + `-Mega X` -> `charizard-mega-x`; `Raichu` + `-Alola` -> `raichu-alola`.
 *
 * Deliberately *not* aliased. This is what appears in URLs and database rows, so it must stay
 * readable and stable: Palafin is `palafin`, not PokeAPI's `palafin-zero`.
 */
export function toSlug(name: string, ig: string | null): string {
  return `${name}${ig ?? ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019.]/g, '') // Farfetch'd \u2192 farfetchd, not farfetch-d
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The slug to look this Pokemon up under on PokeAPI, which is a separate concern: PokeAPI's
 * naming is its own and must not leak into our URLs. Only the roster builder needs this.
 */
export function toPokeApiSlug(name: string, ig: string | null): string {
  const slug = toSlug(name, ig);
  return SLUG_ALIASES[slug] ?? slug;
}

/**
 * The regional-form part of a Mega's form code, used to attach it to the right asset.
 * Strips the `-Mega`/`-Mega X` suffix, so `-Alola-Mega` → `-Alola` and `-Mega Y` → null.
 *
 * Legends: Z-A added a third Mega variant letter (Mega Garchomp Z), so match any letter
 * rather than just X/Y.
 */
export function parentFormCode(ig: string | null): string | null {
  if (!ig) return null;
  const stripped = ig.replace(/-Mega(\s+[A-Z])?\s*$/i, '').trim();
  return stripped || null;
}

export function assetKey(dex: number, ig: string | null): string {
  return `${dex}::${ig ?? ''}`;
}
