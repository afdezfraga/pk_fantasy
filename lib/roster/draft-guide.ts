/**
 * The draft guide: which Pokémon fill each doubles role, and how much each is worth drafting.
 *
 * Two kinds of number live here, and the difference matters. **Power** and **Role** are
 * judgement — anchored on the op.gg ladder, then nudged by hand in `data/draft-guide.json`,
 * where every nudge carries its reason. **Value** and **Pick** are arithmetic on top of that and
 * the shop price, so they move by themselves whenever the market is repriced.
 *
 * Role *membership*, on the other hand, is data: who learns Fake Out or has Intimidate comes
 * from PokéAPI's `champions` learnsets, not from memory. A guide that lists a Fake Out user who
 * can't actually click Fake Out in Champions would be worse than no guide.
 *
 * Pure functions only — the scripts do the file reading, so this stays testable.
 */

import { assetAliases, normalizeName, type NameableEntry, type TierFile } from './tiers.ts';
import { TIERS, type Tier } from '../../config/economy.ts';
import type { BaseStats } from './types.ts';

// --- learnsets ------------------------------------------------------------------------------

/** The slice of a cached PokéAPI `/pokemon/{slug}` response this guide reads. */
export interface ApiPokemon {
  abilities: { ability: { name: string } }[];
  moves: { move: { name: string }; version_group_details: { version_group: { name: string } }[] }[];
}

/**
 * Where a learnset was read from, best first. PokéAPI carries Champions learnsets for most of
 * the roster but not all of it yet (Rillaboom and Indeedee among the gaps), so the newest main
 * game stands in, and the guide says so on the card rather than passing a guess off as fact.
 */
export const LEARNSET_SOURCES = ['champions', 'scarlet-violet', 'sword-shield'] as const;
export type LearnsetSource = (typeof LEARNSET_SOURCES)[number] | 'any';

export interface Kit {
  moves: Set<string>;
  abilities: Set<string>;
  /** The best source any form of this Pokémon had; anything but `champions` is a stand-in. */
  learnsetFrom: LearnsetSource;
}

function learnsetOf(api: ApiPokemon): { moves: Set<string>; from: LearnsetSource } {
  for (const group of LEARNSET_SOURCES) {
    const moves = new Set(
      api.moves
        .filter((m) => m.version_group_details.some((v) => v.version_group.name === group))
        .map((m) => m.move.name),
    );
    if (moves.size > 0) return { moves, from: group };
  }
  return { moves: new Set(api.moves.map((m) => m.move.name)), from: 'any' };
}

/**
 * One tradable asset's kit, pooled across its in-battle forms.
 *
 * Forms are pooled because the asset is: owning Indeedee means you choose which sex to bring,
 * and only the female has Follow Me. Reading the male alone would drop the reason Indeedee is
 * an S-tier from the redirection list.
 */
export function kitFromForms(forms: ApiPokemon[]): Kit {
  const moves = new Set<string>();
  const abilities = new Set<string>();
  let best: LearnsetSource = 'any';
  const rank = (s: LearnsetSource) => (s === 'any' ? 99 : LEARNSET_SOURCES.indexOf(s));

  for (const form of forms) {
    const learnset = learnsetOf(form);
    learnset.moves.forEach((m) => moves.add(m));
    form.abilities.forEach((a) => abilities.add(a.ability.name));
    if (rank(learnset.from) < rank(best)) best = learnset.from;
  }
  return { moves, abilities, learnsetFrom: best };
}

// --- the Pokémon the guide works on ---------------------------------------------------------

export interface GuideMega {
  slug: string;
  label: string;
  types: string[];
  stats: BaseStats | null;
  /** Empty when PokéAPI doesn't carry this Mega yet. */
  abilities: string[];
}

export interface GuideMon {
  slug: string;
  name: string;
  tier: Tier;
  price: number;
  /** op.gg doubles ladder position, 1 = best. */
  rank: number;
  types: string[];
  stats: BaseStats;
  bst: number;
  iconUrl: string | null;
  megas: GuideMega[];
  kit: Kit;
}

/** Display name: "Hisuian Arcanine" rather than name "Arcanine" + form "Hisuian Form". */
export function displayName(entry: { name: string; form: string | null }): string {
  if (!entry.form) return entry.name;
  const word = entry.form.replace(/\bForms?\b/gi, '').replace(/\s+/g, ' ').trim();
  return word ? `${word} ${entry.name}` : entry.name;
}

/**
 * Ladder position of every asset, read off the order of `data/tiers.json`.
 *
 * The tier file lists each tier's Pokémon in ladder order, top tier first, so the position of
 * a name across the whole file *is* its op.gg rank. Reuses the market's own name matching, so
 * the guide and the prices can never disagree about who "Arcanine" is.
 */
export function ladderRanks(file: TierFile, entries: NameableEntry[]): Map<string, number> {
  const byAlias = new Map<string, string>();
  for (const entry of entries) {
    for (const alias of assetAliases(entry)) {
      const key = normalizeName(alias);
      if (key && !byAlias.has(key)) byAlias.set(key, entry.slug);
    }
  }

  const ranks = new Map<string, number>();
  let position = 0;
  for (const tier of TIERS) {
    for (const name of file.tiers[tier] ?? []) {
      position += 1;
      const slug = byAlias.get(normalizeName(name));
      if (slug && !ranks.has(slug)) ranks.set(slug, position);
    }
  }
  return ranks;
}

// --- scores ---------------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const oneDecimal = (n: number) => Math.round(n * 10) / 10;

/** Ladder rank onto 1–10, linearly: #1 is 10, last is 1. */
export function basePower(rank: number, total: number): number {
  if (total <= 1) return 10;
  return oneDecimal(1 + (9 * (total - rank)) / (total - 1));
}

export interface PowerAdjustment {
  adjust: number;
  why: string;
}

export function power(rank: number, total: number, adjustment?: PowerAdjustment): number {
  return oneDecimal(clamp(basePower(rank, total) + (adjustment?.adjust ?? 0), 1, 10));
}

/**
 * How steeply Value reacts to a price gap. At 3, paying half of what that Power usually costs
 * scores about 7, a quarter about 9 — enough to separate a bargain from a fair price without
 * every C-tier pinning at 10.
 */
export const VALUE_SLOPE = 3;

/**
 * Value: Power for the money, 1–10, where 5 is the going rate.
 *
 * Fits log(price) against Power across the whole roster, then scores each Pokémon on how far
 * below (good) or above (bad) the fitted price it sits. Log, because the tier bands are
 * multiplicative — an S costs ~50× a D — and a straight line through raw prices would be
 * dominated by the S-tiers.
 *
 * Because the bands are flat inside a tier while Power keeps falling, the top of every tier
 * scores well and the bottom scores badly. That is not an artefact: it is the tier-cliff
 * bargain the guide exists to point at.
 */
export function valueScores(mons: { slug: string; power: number; price: number }[]): Map<string, number> {
  const xs = mons.map((m) => m.power);
  const ys = mons.map((m) => Math.log(m.price));
  const n = mons.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;

  const out = new Map<string, number>();
  mons.forEach((m, i) => {
    const expected = intercept + slope * xs[i];
    out.set(m.slug, oneDecimal(clamp(5 + VALUE_SLOPE * (expected - ys[i]), 1, 10)));
  });
  return out;
}

/** Draft priority. Power leads — a bargain that loses matches is still a loss. */
export const PICK_WEIGHTS = { power: 0.6, value: 0.4 } as const;

/** Null for anything the opening budget can't buy: those are targets for later, not picks. */
export function pickScore(p: number, value: number, price: number, budget: number): number | null {
  if (price > budget) return null;
  return oneDecimal(PICK_WEIGHTS.power * p + PICK_WEIGHTS.value * value);
}

// --- categories -----------------------------------------------------------------------------

/**
 * Why a Pokémon qualifies for a category, e.g. "Fake Out" or "Intimidate (Mega)". A Pokémon can
 * qualify more than one way; the first reason is the one shown.
 */
export type Qualifier = (mon: GuideMon) => string[];

const has = (mon: GuideMon, move: string) => mon.kit.moves.has(move);
const ability = (mon: GuideMon, name: string) => mon.kit.abilities.has(name);
const megaWith = (mon: GuideMon, name: string) => mon.megas.filter((m) => m.abilities.includes(name));

const title = (slug: string) =>
  slug
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/** Ability on the base form, or on a Mega — labelled so a reader knows which. */
function abilityQualifies(mon: GuideMon, name: string): string[] {
  const reasons: string[] = [];
  if (ability(mon, name)) reasons.push(title(name));
  for (const mega of megaWith(mon, name)) reasons.push(`${title(name)} (${mega.label})`);
  return reasons;
}

function movesQualify(mon: GuideMon, moves: string[]): string[] {
  return moves.filter((m) => has(mon, m)).map(title);
}

/**
 * Spread moves, with the type that makes them same-type. A Pokémon counts as a spread attacker
 * only when a spread move gets STAB (or an -ate ability turns Hyper Voice into one) — otherwise
 * half the roster qualifies on a coverage Rock Slide.
 */
const SPREAD_MOVES: Record<string, string> = {
  earthquake: 'Ground',
  'heat-wave': 'Fire',
  'rock-slide': 'Rock',
  'dazzling-gleam': 'Fairy',
  'hyper-voice': 'Normal',
  surf: 'Water',
  'muddy-water': 'Water',
  eruption: 'Fire',
  'water-spout': 'Water',
  blizzard: 'Ice',
  discharge: 'Electric',
  'make-it-rain': 'Steel',
  'sludge-wave': 'Poison',
  'bleakwind-storm': 'Flying',
  boomburst: 'Normal',
  'lava-plume': 'Fire',
  'petal-blizzard': 'Grass',
  'parabolic-charge': 'Electric',
  'glacial-lance': 'Ice',
  'astral-barrage': 'Ghost',
  snarl: 'Dark',
  'breaking-swipe': 'Dragon',
  'icy-wind': 'Ice',
};
/** Moves that are spread and STAB no matter the user's typing, because their power does the work. */
const ALWAYS_SPREAD = new Set(['eruption', 'water-spout']);
/** Abilities that make Hyper Voice a same-type spread nuke. */
const ATE_ABILITIES: Record<string, string> = {
  pixilate: 'Fairy',
  aerilate: 'Flying',
  refrigerate: 'Ice',
  dragonize: 'Dragon',
};
/** Weak spread moves that don't make an attacker on their own; they're utility. */
const WEAK_SPREAD = new Set(['snarl', 'icy-wind', 'breaking-swipe']);

function spreadQualifies(mon: GuideMon): string[] {
  const types = new Set([...mon.types, ...mon.megas.flatMap((m) => m.types)]);
  const reasons: string[] = [];
  for (const [move, type] of Object.entries(SPREAD_MOVES)) {
    if (WEAK_SPREAD.has(move) || !has(mon, move)) continue;
    if (ALWAYS_SPREAD.has(move) || types.has(type)) reasons.push(title(move));
  }
  if (has(mon, 'hyper-voice')) {
    for (const [ate, type] of Object.entries(ATE_ABILITIES)) {
      for (const mega of megaWith(mon, ate)) reasons.push(`${type} Hyper Voice (${mega.label})`);
      if (ability(mon, ate)) reasons.push(`${type} Hyper Voice`);
    }
  }
  return reasons;
}

const PRIORITY_MOVES = [
  'grassy-glide',
  'sucker-punch',
  'extreme-speed',
  'bullet-punch',
  'aqua-jet',
  'mach-punch',
  'ice-shard',
  'shadow-sneak',
  'jet-punch',
  'first-impression',
  'vacuum-wave',
  'accelerock',
  'thunderclap',
  'upper-hand',
];

function priorityQualifies(mon: GuideMon): string[] {
  const reasons = movesQualify(mon, PRIORITY_MOVES);
  // Gale Wings makes Brave Bird priority at full HP.
  if (ability(mon, 'gale-wings') && has(mon, 'brave-bird')) reasons.push('Gale Wings Brave Bird');
  return reasons;
}

/**
 * Slow enough to move first under Trick Room, strong enough to be worth it. 55, not 60: at 60
 * the list fills with Incineroar and Sylveon, which are slow but are not what you set Trick Room
 * for.
 */
export const TR_MAX_SPEED = 55;
export const TR_MIN_ATTACK = 105;

function trickRoomAttacker(mon: GuideMon): string[] {
  const reasons: string[] = [];
  const hits = (s: BaseStats) => s.spe <= TR_MAX_SPEED && Math.max(s.atk, s.spa) >= TR_MIN_ATTACK;
  if (hits(mon.stats)) reasons.push(`Speed ${mon.stats.spe}`);
  // Eruption and Water Spout do their damage from full HP, not from the attacking stat, so a
  // slow user with modest Sp. Atk is still the scariest thing under Trick Room — Torkoal.
  else if (mon.stats.spe <= TR_MAX_SPEED && (has(mon, 'eruption') || has(mon, 'water-spout'))) {
    reasons.push(`Speed ${mon.stats.spe}, ${has(mon, 'eruption') ? 'Eruption' : 'Water Spout'}`);
  }
  for (const mega of mon.megas) {
    if (mega.stats && hits(mega.stats)) reasons.push(`${mega.label}, Speed ${mega.stats.spe}`);
  }
  return reasons;
}

const UTILITY: [string, (mon: GuideMon) => boolean][] = [
  ['Prankster', (m) => ability(m, 'prankster') || megaWith(m, 'prankster').length > 0],
  ['Wide Guard', (m) => has(m, 'wide-guard')],
  ['Quick Guard', (m) => has(m, 'quick-guard')],
  ['Spore / Sleep Powder', (m) => has(m, 'spore') || has(m, 'sleep-powder')],
  ['Aurora Veil', (m) => has(m, 'aurora-veil')],
  ['Parting Shot', (m) => has(m, 'parting-shot')],
  ['Instruct', (m) => has(m, 'instruct')],
  ['Perish Song', (m) => has(m, 'perish-song')],
  ['Ally Switch', (m) => has(m, 'ally-switch')],
  ['Friend Guard', (m) => ability(m, 'friend-guard')],
  ['Both screens', (m) => has(m, 'reflect') && has(m, 'light-screen')],
  ['Will-O-Wisp', (m) => has(m, 'will-o-wisp')],
  ['Icy Wind / Electroweb', (m) => has(m, 'icy-wind') || has(m, 'electroweb')],
];

/**
 * The tags that qualify a Pokémon for the utility list: the first ten. Screens, Will-O-Wisp and
 * Icy Wind are shown on cards but don't qualify on their own — each is on a hundred-odd
 * Pokémon, and a list of 120 "support Pokémon" tells a drafter nothing.
 */
const UTILITY_QUALIFYING = new Set(UTILITY.slice(0, 10).map(([label]) => label));

export function utilityTags(mon: GuideMon): string[] {
  return UTILITY.filter(([, test]) => test(mon)).map(([label]) => label);
}

export const CATEGORY_KEYS = [
  'megas',
  'fake-out',
  'intimidate',
  'tailwind',
  'trick-room',
  'tr-attackers',
  'redirection',
  'rain',
  'sun',
  'sand',
  'snow',
  'terrain',
  'spread',
  'priority',
  'utility',
  'budget',
  'save-up',
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** Price ceiling for the budget list. Five of these plus one real pick still fits the budget. */
export const BUDGET_CEILING = 60_000;

export interface QualifyContext {
  budget: number;
}

/**
 * Who qualifies for each category, and why. `budget` and `save-up` are about price, not kit;
 * everything else is read from moves, abilities and stats.
 */
export function qualifiers(ctx: QualifyContext): Record<CategoryKey, Qualifier> {
  return {
    megas: (m) => m.megas.map((mega) => mega.label),
    'fake-out': (m) => movesQualify(m, ['fake-out']),
    intimidate: (m) => abilityQualifies(m, 'intimidate'),
    tailwind: (m) => movesQualify(m, ['tailwind']),
    'trick-room': (m) => movesQualify(m, ['trick-room']),
    'tr-attackers': trickRoomAttacker,
    redirection: (m) => movesQualify(m, ['follow-me', 'rage-powder']),
    rain: (m) => [
      ...abilityQualifies(m, 'drizzle').map((r) => `Sets rain: ${r}`),
      ...abilityQualifies(m, 'swift-swim'),
      ...(has(m, 'electro-shot') ? ['Electro Shot (no charge in rain)'] : []),
    ],
    sun: (m) => [
      ...abilityQualifies(m, 'drought').map((r) => `Sets sun: ${r}`),
      ...abilityQualifies(m, 'chlorophyll'),
      ...abilityQualifies(m, 'solar-power'),
    ],
    sand: (m) => [
      ...abilityQualifies(m, 'sand-stream').map((r) => `Sets sand: ${r}`),
      ...abilityQualifies(m, 'sand-rush'),
      ...abilityQualifies(m, 'sand-force'),
    ],
    snow: (m) => [
      ...abilityQualifies(m, 'snow-warning').map((r) => `Sets snow: ${r}`),
      ...abilityQualifies(m, 'slush-rush'),
      ...(has(m, 'aurora-veil') ? ['Aurora Veil'] : []),
    ],
    terrain: (m) => [
      ...abilityQualifies(m, 'psychic-surge'),
      ...abilityQualifies(m, 'electric-surge'),
      ...abilityQualifies(m, 'grassy-surge'),
      ...abilityQualifies(m, 'misty-surge'),
    ],
    spread: spreadQualifies,
    priority: priorityQualifies,
    utility: (m) => utilityTags(m).filter((t) => UTILITY_QUALIFYING.has(t)),
    budget: (m) => (m.price <= BUDGET_CEILING ? ['Under the budget ceiling'] : []),
    'save-up': (m) => (m.price > ctx.budget ? ['Over the opening budget'] : []),
  };
}

// --- sample squads --------------------------------------------------------------------------

export interface Squad {
  name: string;
  idea: string;
  /** The one Pokémon this squad plans to Mega Evolve, if any. Only one Mega per battle. */
  mega: string | null;
  slugs: string[];
}

/**
 * Everything wrong with a sample squad, or nothing. The guide refuses to print a squad a club
 * couldn't actually draft: over budget, the wrong size, a duplicate, or a Mega it doesn't own.
 */
export function squadProblems(
  squad: Squad,
  bySlug: Map<string, Pick<GuideMon, 'price' | 'megas'>>,
  rules: { budget: number; size: number },
): string[] {
  const problems: string[] = [];
  const missing = squad.slugs.filter((s) => !bySlug.has(s));
  if (missing.length) problems.push(`unknown Pokémon: ${missing.join(', ')}`);
  if (squad.slugs.length !== rules.size) problems.push(`has ${squad.slugs.length} Pokémon, not ${rules.size}`);
  if (new Set(squad.slugs).size !== squad.slugs.length) problems.push('lists a Pokémon twice');

  const total = squad.slugs.reduce((sum, s) => sum + (bySlug.get(s)?.price ?? 0), 0);
  if (total > rules.budget) problems.push(`costs ₽${total}, over the ₽${rules.budget} budget`);

  if (squad.mega) {
    if (!squad.slugs.includes(squad.mega)) problems.push(`Megas ${squad.mega}, which isn't in the squad`);
    else if (!bySlug.get(squad.mega)?.megas.length) problems.push(`${squad.mega} has no Mega Evolution`);
  }
  return problems;
}

// --- a simulated draft ----------------------------------------------------------------------

/**
 * Deterministic PRNG (mulberry32), so a simulated draft reads the same every time the report is
 * rebuilt and a diff of the report means the market moved, not the dice.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from two uniforms (Box–Muller). */
function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimInput {
  mons: { slug: string; power: number; price: number }[];
  teams: number;
  rounds: number;
  budget: number;
  runs: number;
  /** How much rivals disagree with the Power scores — 1.0 is about one tier's worth. */
  noise: number;
  /** What a rival keeps back per remaining pick, so they can still fill a squad. */
  reservePerPick: number;
  seed: number;
}

export interface SimResult {
  /** slug → overall pick numbers (1-based) at which it went, one per run it was taken. */
  takenAt: Map<string, number[]>;
  runs: number;
  totalPicks: number;
}

/**
 * Simulates the snake draft with every club drafting like a typical rival: take the strongest
 * Pokémon you can afford while keeping enough back to fill the rest of the squad. Rivals are
 * modelled on Power (with noise), deliberately not on Value — the point is to see which
 * bargains a Power-first room leaves on the table, and for how long.
 */
export function simulateDraft(input: SimInput): SimResult {
  const random = seededRandom(input.seed);
  const takenAt = new Map<string, number[]>();
  const totalPicks = input.teams * input.rounds;

  for (let run = 0; run < input.runs; run += 1) {
    const cash = Array.from({ length: input.teams }, () => input.budget);
    const taken = new Set<string>();
    // Each club sees the market slightly differently; fixed per club for the whole draft.
    const views = Array.from({ length: input.teams }, () => {
      const view = new Map<string, number>();
      for (const m of input.mons) view.set(m.slug, m.power + input.noise * gaussian(random));
      return view;
    });

    for (let cursor = 0; cursor < totalPicks; cursor += 1) {
      const round = Math.floor(cursor / input.teams);
      const index = cursor % input.teams;
      const team = round % 2 === 1 ? input.teams - 1 - index : index;
      const reserve = input.reservePerPick * (input.rounds - round - 1);

      let best: { slug: string; price: number } | null = null;
      let bestScore = -Infinity;
      for (const m of input.mons) {
        if (taken.has(m.slug) || m.price > cash[team] - reserve) continue;
        const score = views[team].get(m.slug)!;
        if (score > bestScore) {
          bestScore = score;
          best = m;
        }
      }
      if (!best) continue; // Out of money: the club skips, as the real draft allows.
      taken.add(best.slug);
      cash[team] -= best.price;
      const list = takenAt.get(best.slug) ?? [];
      list.push(cursor + 1);
      takenAt.set(best.slug, list);
    }
  }
  return { takenAt, runs: input.runs, totalPicks };
}

/**
 * Share of runs in which a Pokémon was drafted at all.
 *
 * Needed alongside the pick number because most of the A+ tier goes undrafted: only one fits a
 * budget, so an eight-club draft takes about eight of thirty-five. "When does it go" is the
 * wrong question for those; "how often does anyone take it" is the right one.
 */
export function takenShare(result: SimResult, slug: string): number {
  return (result.takenAt.get(slug)?.length ?? 0) / result.runs;
}

/** Median overall pick among the runs in which it was taken, or null if it never was. */
export function medianWhenTaken(result: SimResult, slug: string): number | null {
  const picks = [...(result.takenAt.get(slug) ?? [])].sort((a, b) => a - b);
  return picks.length ? picks[Math.floor((picks.length - 1) / 2)] : null;
}

/** Share of runs in which a Pokémon was still on the board before overall pick `pick`. */
export function availableAt(result: SimResult, slug: string, pick: number): number {
  const picks = result.takenAt.get(slug) ?? [];
  const goneBefore = picks.filter((p) => p < pick).length;
  return 1 - goneBefore / result.runs;
}
