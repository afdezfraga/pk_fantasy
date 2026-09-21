/** Shape of `data/roster.json`, produced by `scripts/build-roster.ts`. */

import type { Tier } from '../../config/economy.ts';

export interface MegaForm {
  slug: string;
  label: string;
  types: string[];
  bst: number;
  /** True when PokéAPI doesn't carry this Mega yet and BST was inferred as base + 100. */
  bstEstimated: boolean;
  stats: BaseStats | null;
  spriteUrl: string | null;
  iconUrl: string | null;
  homeUrl: string | null;
  /** This Mega's own competitive tier, from data/tiers.json. */
  tier: Tier;
}

export interface AlternateForm {
  slug: string;
  label: string;
  types: string[];
  /** Null when the form isn't modelled separately on PokéAPI (cosmetic patterns, etc.). */
  bst: number | null;
}

export interface BaseStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface RosterEntry {
  /** Stable identity across rebuilds; appears in URLs and database rows. */
  slug: string;
  /** Where this was looked up on PokéAPI — differs from `slug` for a handful (see SLUG_ALIASES). */
  pokeapiSlug: string;
  dex: number;
  name: string;
  /** Regional form label, e.g. "Alolan Form". Null for the base species. */
  form: string | null;
  types: string[];
  stats: BaseStats;
  bst: number;
  megas: MegaForm[];
  /** In-battle forms (Rotom appliances, Castform weather). Display only — not tradable. */
  alternateForms: AlternateForm[];
  /** Big illustrated artwork. Best looking, heaviest — for a hero image, not a list. */
  spriteUrl: string | null;
  /** The 96px game sprite. A few KB, so lists of hundreds stay cheap to scroll. */
  iconUrl: string | null;
  /** The Pokémon HOME render. Mid-weight and modern — the card treatment. */
  homeUrl: string | null;
  /** False only once a roster rotation drops this Pokémon from Champions entirely. */
  legal: boolean;
  /**
   * On the roster, but you can't just catch one — transfer-only or event-only. Still a real
   * Champions Pokémon; whether a league lets you sign it is `allowTransferOnly` in its config.
   */
  restricted: boolean;
  /** Availability caveat from the source, e.g. "Regular form only", "Transfer only". */
  notes: string | null;
  versionAdded: string;
  /** Best tier this asset can reach, counting its Megas. Drives price. */
  tier: Tier;
  /** BST of the strongest form it can reach in battle (Mega, or a transform like Palafin Hero). */
  effectiveBst: number;
  baseValue: number;
}

export interface RosterFile {
  generatedAt: string;
  source: {
    page: string;
    revisionId: number;
    url: string;
  };
  counts: {
    assets: number;
    species: number;
    regionalForms: number;
    megas: number;
    alternateForms: number;
    legal: number;
  };
  pokemon: RosterEntry[];
}
