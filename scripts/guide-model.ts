/**
 * Loads everything the draft guide and the draft report are built from, and scores it.
 *
 * Shared by `scripts/draft-guide.ts` (the HTML guide) and `scripts/draft-report.ts` (the PDF),
 * so the two can never disagree about a price or a score.
 *
 * Reads the PokéAPI cache that `roster:build` fills. The cache is gitignored, so on a fresh
 * clone this stops and says so rather than rendering a guide in which nobody has any moves.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEAGUE_DEFAULTS } from '../config/economy.ts';
import {
  CATEGORY_KEYS,
  displayName,
  kitFromForms,
  ladderRanks,
  pickScore,
  power,
  qualifiers,
  squadProblems,
  utilityTags,
  valueScores,
  type ApiPokemon,
  type CategoryKey,
  type GuideMon,
  type PowerAdjustment,
  type Squad,
} from '../lib/roster/draft-guide.ts';
import type { TierFile } from '../lib/roster/tiers.ts';
import type { RosterFile } from '../lib/roster/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache/pokeapi');

/** A hand-scored entry: how good this Pokémon is at the category's job, and why. */
export interface RolePick {
  role: number;
  note: string;
}

export interface CategoryCopy {
  key: CategoryKey;
  title: string;
  /** Three or four words, shown above the title. */
  kicker: string;
  /** Why this matters in doubles, in one or two sentences a newer player can follow. */
  why: string;
  picks: Record<string, RolePick>;
}

/** Shape of `data/draft-guide.json`. */
export interface GuideFile {
  power: Record<string, PowerAdjustment>;
  categories: CategoryCopy[];
  squads: Squad[];
}

export interface ScoredMon extends GuideMon {
  basePower: number;
  power: number;
  adjustment: PowerAdjustment | null;
  value: number;
  /** Null when the opening budget can't buy it. */
  pick: number | null;
  tags: string[];
  /** Categories this Pokémon qualifies for, with the reasons. */
  qualifies: Partial<Record<CategoryKey, string[]>>;
}

export interface CardEntry {
  mon: ScoredMon;
  role: number;
  note: string;
  reasons: string[];
}

export interface Category extends CategoryCopy {
  /** Hand-scored, best first. */
  cards: CardEntry[];
  /** Everyone else who qualifies, strongest first. */
  others: { mon: ScoredMon; reasons: string[] }[];
}

export interface GuideModel {
  mons: ScoredMon[];
  bySlug: Map<string, ScoredMon>;
  categories: Category[];
  squads: (Squad & { total: number; members: ScoredMon[] })[];
  tierFile: TierFile & { sourceUrl?: string };
  roster: RosterFile;
  budget: number;
  lineup: number;
  total: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function cached(slug: string): ApiPokemon | null {
  const path = join(CACHE, `${slug}.json`);
  return existsSync(path) ? readJson<ApiPokemon>(path) : null;
}

export function loadGuide(): GuideModel {
  if (!existsSync(CACHE)) {
    throw new Error('No PokéAPI cache at .cache/pokeapi — run `npm run roster:build` first; it fills it.');
  }

  const roster = readJson<RosterFile>(join(ROOT, 'data/roster.json'));
  const tierFile = readJson<TierFile & { sourceUrl?: string }>(join(ROOT, 'data/tiers.json'));
  const guide = readJson<GuideFile>(join(ROOT, 'data/draft-guide.json'));
  const budget = LEAGUE_DEFAULTS.startingCash;

  const entries = roster.pokemon.filter((p) => p.legal);
  const ranks = ladderRanks(tierFile, entries);
  // Anything the ladder doesn't mention sorts to the bottom rather than vanishing.
  const total = entries.length;

  const problems: string[] = [];
  const base: GuideMon[] = entries.map((p) => {
    const forms = [p.pokeapiSlug, ...p.alternateForms.map((a) => a.slug)]
      .map(cached)
      .filter((f): f is ApiPokemon => f !== null);
    if (forms.length === 0) problems.push(`${p.slug}: nothing cached for ${p.pokeapiSlug}`);

    return {
      slug: p.slug,
      name: displayName(p),
      tier: p.tier,
      price: p.baseValue,
      rank: ranks.get(p.slug) ?? total,
      types: p.types,
      stats: p.stats,
      bst: p.bst,
      iconUrl: p.iconUrl,
      megas: p.megas.map((m) => ({
        slug: m.slug,
        label: m.label,
        types: m.types,
        stats: m.stats,
        abilities: cached(m.slug)?.abilities.map((a) => a.ability.name) ?? [],
      })),
      kit: kitFromForms(forms),
    };
  });

  if (problems.length) {
    throw new Error(`The PokéAPI cache is incomplete — rerun \`npm run roster:build\`:\n  ${problems.join('\n  ')}`);
  }

  // Power first, then Value off Power, then Pick off both.
  const powered = base.map((m) => {
    const adjustment = guide.power[m.slug] ?? null;
    return { ...m, adjustment, power: power(m.rank, total, adjustment ?? undefined) };
  });
  const values = valueScores(powered.map((m) => ({ slug: m.slug, power: m.power, price: m.price })));

  const rules = qualifiers({ budget });
  const mons: ScoredMon[] = powered.map((m) => {
    const value = values.get(m.slug)!;
    const qualifies: ScoredMon['qualifies'] = {};
    for (const key of CATEGORY_KEYS) {
      const reasons = rules[key](m);
      if (reasons.length) qualifies[key] = reasons;
    }
    return {
      ...m,
      basePower: power(m.rank, total),
      value,
      pick: pickScore(m.power, value, m.price, budget),
      tags: utilityTags(m),
      qualifies,
    };
  });
  const bySlug = new Map(mons.map((m) => [m.slug, m]));

  // Every hand-written slug must exist, and every hand-scored Pokémon must actually qualify:
  // a role score on a Pokémon that can't do the job is a typo or a stale opinion.
  const unknown = Object.keys(guide.power).filter((s) => !bySlug.has(s));
  const byStrength = (a: ScoredMon, b: ScoredMon) => b.power - a.power || a.price - b.price;

  const categories: Category[] = guide.categories.map((copy) => {
    if (!CATEGORY_KEYS.includes(copy.key)) unknown.push(`category ${copy.key}`);
    const cards: CardEntry[] = [];
    for (const [slug, pick] of Object.entries(copy.picks)) {
      const mon = bySlug.get(slug);
      if (!mon) {
        unknown.push(`${copy.key}: ${slug}`);
        continue;
      }
      const reasons = mon.qualifies[copy.key];
      if (!reasons) {
        unknown.push(`${copy.key}: ${slug} doesn't qualify (check its learnset)`);
        continue;
      }
      cards.push({ mon, role: pick.role, note: pick.note, reasons });
    }
    cards.sort((a, b) => b.role - a.role || byStrength(a.mon, b.mon));

    const carded = new Set(cards.map((c) => c.mon.slug));
    const others = mons
      .filter((m) => m.qualifies[copy.key] && !carded.has(m.slug))
      .sort(copy.key === 'budget' ? (a, b) => (b.pick ?? 0) - (a.pick ?? 0) : byStrength)
      .map((mon) => ({ mon, reasons: mon.qualifies[copy.key]! }));

    return { ...copy, cards, others };
  });

  const squads = guide.squads.map((squad) => {
    const issues = squadProblems(squad, bySlug, { budget, size: LEAGUE_DEFAULTS.lineupSize });
    if (issues.length) unknown.push(`squad "${squad.name}" ${issues.join('; ')}`);
    const members = squad.slugs.map((s) => bySlug.get(s)).filter((m): m is ScoredMon => Boolean(m));
    return { ...squad, members, total: members.reduce((sum, m) => sum + m.price, 0) };
  });

  if (unknown.length) {
    throw new Error(`data/draft-guide.json doesn't match the roster:\n  ${unknown.join('\n  ')}`);
  }

  return {
    mons,
    bySlug,
    categories,
    squads,
    tierFile,
    roster,
    budget,
    lineup: LEAGUE_DEFAULTS.lineupSize,
    total,
  };
}
