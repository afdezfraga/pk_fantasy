/**
 * Resolves the hand-maintained tier list in `data/tiers.json` against the parsed roster.
 *
 * The tier file is written in readable display names ("Alolan Ninetales", "Mega Charizard Y",
 * "Wash Rotom") because a human edits it. This maps those onto roster slugs, and — critically —
 * reports every name it could not match instead of dropping it, so a typo or a renamed Pokémon
 * surfaces at build time rather than as a mysteriously cheap Pokémon mid-season.
 */

import { TIERS, type Tier } from '../../config/economy.ts';

export interface TierFile {
  source: string;
  sourceUrl?: string;
  /** Which format these tiers describe. Champions is a doubles game by default. */
  format?: 'doubles' | 'singles';
  updated: string;
  defaultTier: Tier;
  /**
   * Whether `tiers` already accounts for each species' Mega Evolutions. Doubles lists usually
   * do (Staraptor ranks S because of Mega Staraptor), in which case a Mega's own tier must not
   * promote its species a second time.
   */
  baseTiersIncludeMegas?: boolean;
  /** Tiers for tradable assets, keyed by tier name. */
  tiers: Record<string, string[]>;
  /** Optional tiers for individual Mega forms, where a Mega is ranked apart from its species. */
  megaTiers?: Record<string, string[] | string>;
}

/** Normalizes a display name for matching: lowercase, no punctuation, no form-word noise. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(forme?|pattern|male|female)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Every name a roster entry could plausibly be called in a tier list. */
export interface NameableEntry {
  slug: string;
  name: string;
  form: string | null;
  megas: { slug: string; label: string }[];
  alternateForms: { slug: string; label: string }[];
}

/**
 * Aliases for an asset itself (not its Megas). A tier list says "Alolan Ninetales" or
 * "Hisuian Samurott"; the wiki says name "Ninetales" + form "Alolan Form".
 */
export function assetAliases(entry: NameableEntry): string[] {
  const aliases = [entry.name];

  if (entry.form) {
    // "Alolan Form" → "Alolan Ninetales"; "Eternal Flower" → "Eternal Flower Floette".
    const formWord = entry.form.replace(/\bForm(e)?\b/gi, '').trim();
    if (formWord) {
      aliases.push(`${formWord} ${entry.name}`, `${entry.name} ${formWord}`);
    }
    aliases.push(entry.form);
  }

  // Alternate forms are not separately tradable, so a tier for one ("Wash Rotom") is a tier
  // for the asset that owns it.
  for (const alt of entry.alternateForms) aliases.push(alt.label);

  return aliases;
}

export interface ResolvedTiers {
  /** Asset slug → tier assigned directly to that Pokémon (excluding its Megas). */
  bySlug: Map<string, Tier>;
  /** Mega slug → tier. */
  byMegaSlug: Map<string, Tier>;
  /** Tier-list names that matched nothing in the roster. */
  unmatched: string[];
}

export function resolveTiers(file: TierFile, entries: NameableEntry[]): ResolvedTiers {
  // Build lookup tables from every alias to the thing it names.
  const assetByAlias = new Map<string, string>();
  const megaByAlias = new Map<string, string>();

  for (const entry of entries) {
    for (const alias of assetAliases(entry)) {
      const key = normalizeName(alias);
      // First writer wins: the base species claims a bare name before a form can.
      if (key && !assetByAlias.has(key)) assetByAlias.set(key, entry.slug);
    }
    for (const mega of entry.megas) {
      const key = normalizeName(mega.label);
      if (key && !megaByAlias.has(key)) megaByAlias.set(key, mega.slug);
    }
  }

  const bySlug = new Map<string, Tier>();
  const byMegaSlug = new Map<string, Tier>();
  const unmatched: string[] = [];

  // Megas first, so an explicit Mega tier isn't overwritten by a name collision below.
  for (const tier of TIERS) {
    const names = file.megaTiers?.[tier];
    if (!Array.isArray(names)) continue; // skips the "_comment" string key
    for (const name of names) {
      const key = normalizeName(name);
      const megaSlug = megaByAlias.get(key);
      if (megaSlug) byMegaSlug.set(megaSlug, tier);
      else unmatched.push(`${name} (mega ${tier})`);
    }
  }

  for (const tier of TIERS) {
    for (const name of file.tiers[tier] ?? []) {
      const key = normalizeName(name);
      // A name like "Mega Charizard Y" listed among the main tiers still means the Mega.
      const megaSlug = megaByAlias.get(key);
      if (megaSlug) {
        if (!byMegaSlug.has(megaSlug)) byMegaSlug.set(megaSlug, tier);
        continue;
      }
      const assetSlug = assetByAlias.get(key);
      if (assetSlug) {
        bySlug.set(assetSlug, tier);
        continue;
      }
      unmatched.push(`${name} (${tier})`);
    }
  }

  return { bySlug, byMegaSlug, unmatched };
}
