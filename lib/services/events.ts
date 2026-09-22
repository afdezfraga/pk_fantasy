/**
 * Random events, as decisions a manager makes.
 *
 * An event is a problem, not a number that moves by itself. It is drawn for one club every few
 * matches, it blocks that club from reporting another match until it is answered, and answering
 * it costs something — money, a Pokémon's availability, or the freedom to battle the way you
 * would like to for the next few matches.
 *
 * Three rules hold the whole thing up:
 *
 * 1. **Every template offers something a club can always click.** Reporting is blocked while an
 *    event is pending, so an unanswerable event is a dead league. `validateDeck` refuses to load
 *    a deck that breaks this, and delegation is available on nearly everything as a backstop.
 * 2. **Options are frozen at draw time.** The rendered text, the resolved target and the exact
 *    cost in Pokédollars are written onto the row, so editing `data/events.json` can never change
 *    an event somebody is halfway through answering.
 * 3. **A fired trigger beats a random draw.** An event caused by how you have actually been
 *    managing — a Pokémon you forgot about, a squad you churned — is always more interesting than
 *    one rolled from the deck, so it jumps the queue.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Prisma } from '@prisma/client';

import { roundTo } from '../../config/economy.ts';
import { winReward } from '../../config/scoring.ts';
import { db } from '../db.ts';
import { money, pokemonLabel } from '../format.ts';
import {
  addEffect,
  chargeForEvent,
  cashCost,
  effectScope,
  isEffectKind,
  isInstant,
  moveTypeValue,
  moveValue,
  type EffectKind,
  type EffectParams,
} from './effects.ts';
import { audit } from './money.ts';
import { claimFreeAgent, parseConfig, releaseToMarket } from './ownership.ts';
import { buildContext, fires, meetsRequires, type EventContext, type Requires, type Trigger } from './triggers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export class EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventError';
  }
}

/** Thrown when a club tries to report a match with a decision still outstanding. */
export class EventPendingError extends Error {
  constructor(title: string) {
    super(`Answer "${title}" on the Events page before reporting another match.`);
    this.name = 'EventPendingError';
  }
}

// --- the deck -----------------------------------------------------------------------------------

/** How a cost is worked out. Both freeze to a concrete number of Pokédollars at draw time. */
export interface CostSpec {
  kind: 'CASH_PCT' | 'VALUE_PCT';
  pct: number;
  min?: number;
}

export interface EffectSpecJson {
  kind: string;
  /** Overrides the template's target for this one effect. */
  target?: string;
  matches?: number;
  rounds?: number;
  pct?: number;
  times?: number;
  count?: number;
  amount?: number;
  min?: number;
  type?: string;
  item?: string;
  /** SWAP_OFFER: how far from the leaving Pokémon's value the arrival may be, as a percentage. */
  band?: number;
  /** PLEDGE: the wager. */
  wins?: number;
  outOf?: number;
  reward?: number;
  penalty?: number;
  /** ESCROW: what comes back, as a percentage of what went in. */
  returnPct?: number;
  /**
   * Ripples a milder copy of this effect across the rest of the starting lineup.
   *
   * Upsetting the Pokémon the rest of the squad looks to is not a private matter, so a captain
   * event resolved badly reaches further than the captain. The copies are picked and frozen at
   * draw time like everything else, and last `spreadPct` of the original.
   */
  spreadTo?: 'starters';
  spreadCount?: number;
  spreadPct?: number;
  spreadLabel?: string;
  spreadLiftedMessage?: string;
  /**
   * Money priced in wins rather than Pokédollars.
   *
   * A win is worth ₽1,000 in the beginner tier and ₽100,000 in Champion, so any flat figure is
   * either pocket change or a season's earnings depending on who drew it. Pricing a wager in
   * what the club's own matches are worth is the only way one number reads the same to everyone.
   */
  amountWins?: number;
  rewardWins?: number;
  penaltyWins?: number;
  label?: string;
  liftedMessage?: string;
}

export interface OptionSpec {
  key: string;
  label: string;
  detail: string;
  default?: boolean;
  requires?: Requires;
  cost?: CostSpec;
  /**
   * Turns one authored option into one option per candidate Pokémon, each fully resolved.
   *
   * This is how a club picks *which* Pokémon an event takes without the app needing a second
   * kind of answer: "release Garchomp" and "release Ferrothorn" are two ordinary options, so a
   * decision is still just a key, and delegation, freezing and the commissioner's fallback all
   * keep working unchanged.
   */
  repeat?: '@starters';
  /** How many to offer. Three is enough to span the squad without burying the alternative. */
  repeatMax?: number;
  effects: EffectSpecJson[];
}

export interface EventTemplate {
  key: string;
  title: string;
  description: string;
  scope: 'team' | 'league';
  weight: number;
  cooldown?: number;
  delegable?: boolean;
  tierLadder?: boolean;
  requires?: Requires;
  trigger?: Trigger;
  target?: string;
  /**
   * Multipliers on how hard this lands, by who it landed on.
   *
   * `captain` applies when the resolved subject is the club's captain: the same event costs more
   * and lasts longer when it is the Pokémon the squad takes its lead from.
   */
  severityMult?: { captain?: number };
  virtueChance?: number;
  virtue?: { title: string; description: string; effects: EffectSpecJson[] };
  options: OptionSpec[];
}

let cache: EventTemplate[] | null = null;

export function loadDeck(): EventTemplate[] {
  if (!cache) {
    const file = JSON.parse(readFileSync(join(ROOT, 'data/events.json'), 'utf8'));
    cache = file.events as EventTemplate[];
  }
  return cache;
}

/** Test seam — forces the next `loadDeck` to re-read from disk. */
export function clearDeckCache(): void {
  cache = null;
}

/**
 * Everything that must hold for a deck to be safe to draw from.
 *
 * Run by the test suite over the shipped deck, and cheap enough to run at draw time so a
 * hand-edited deck fails loudly rather than stranding a club behind an unanswerable event.
 */
export function validateDeck(deck: EventTemplate[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const template of deck) {
    const where = `event "${template.key}"`;
    if (seen.has(template.key)) problems.push(`${where}: duplicate key`);
    seen.add(template.key);

    if (!(template.weight > 0)) problems.push(`${where}: weight must be positive`);
    if (template.scope !== 'team' && template.scope !== 'league') {
      problems.push(`${where}: scope must be "team" or "league"`);
    }
    if (template.options.length < 2) problems.push(`${where}: needs at least two options`);
    if (template.options.length > 2 && !template.tierLadder && template.options.length !== 3) {
      problems.push(`${where}: more than three options`);
    }

    // The invariant hard block depends on: something is always clickable.
    const unconditional = template.options.filter((option) => !option.cost && !option.requires);
    if (unconditional.length === 0) {
      problems.push(`${where}: every event needs an option with no cost and no requirements`);
    }

    const defaults = template.options.filter((option) => option.default);
    if (defaults.length !== 1) {
      problems.push(`${where}: needs exactly one option marked default (found ${defaults.length})`);
    }
    if (defaults[0] && (defaults[0].cost || defaults[0].requires)) {
      problems.push(`${where}: the default option must be unconditional`);
    }
    // A repeating option offers one branch per Pokémon, so it offers none to a club with no
    // starters. The fallback every event is required to have must not be able to vanish.
    if (defaults[0]?.repeat) {
      problems.push(`${where}: the default option cannot repeat over the squad`);
    }

    for (const option of template.options) {
      if (option.cost && option.cost.min === undefined) {
        problems.push(
          `${where}, option "${option.key}": a percentage cost needs a "min" floor, or a broke club pays nothing`,
        );
      }
      for (const effect of option.effects) problems.push(...checkEffect(effect, `${where}, option "${option.key}"`));
    }

    for (const effect of template.virtue?.effects ?? []) {
      problems.push(...checkEffect(effect, `${where}, virtue`));
    }
  }

  return problems;
}

function checkEffect(effect: EffectSpecJson, where: string): string[] {
  const problems: string[] = [];
  if (!isEffectKind(effect.kind)) {
    problems.push(`${where}: unknown effect kind "${effect.kind}"`);
    return problems;
  }
  // A lasting effect that cannot describe itself is one nobody will notice they have.
  if (!isInstant(effect.kind)) {
    if (!effect.label) problems.push(`${where}: effect ${effect.kind} needs a label`);
    if (!effect.liftedMessage) problems.push(`${where}: effect ${effect.kind} needs a liftedMessage`);
    // A wager's window is its duration; saying it twice is a way for the two to disagree.
    if (!effect.matches && !effect.rounds && effect.kind !== 'PLEDGE') {
      problems.push(`${where}: effect ${effect.kind} needs a duration in matches or rounds`);
    }
  }

  // The parameters each of these is useless without. A wager with no target, a swap with no
  // band and a bond with nothing to return are all events that would draw and then do nothing.
  if (effect.kind === 'PLEDGE') {
    if (!effect.wins || !effect.outOf || effect.wins > effect.outOf) {
      problems.push(`${where}: PLEDGE needs wins and outOf, with wins no greater than outOf`);
    }
    if (!effect.reward && !effect.penalty && !effect.rewardWins && !effect.penaltyWins) {
      problems.push(`${where}: PLEDGE needs a reward, a penalty, or both`);
    }
  }
  if (effect.kind === 'ESCROW') {
    if (effect.pct !== undefined && effect.min === undefined) {
      problems.push(`${where}: ESCROW priced as a percentage needs a "min" floor`);
    }
    if ((!effect.amount && !effect.amountWins && !effect.pct) || !effect.returnPct || !effect.rounds) {
      problems.push(`${where}: ESCROW needs an amount, a returnPct and a duration in rounds`);
    }
  }
  if (effect.kind === 'SWAP_OFFER' && !effect.band) {
    problems.push(`${where}: SWAP_OFFER needs a band, or "of similar value" means nothing`);
  }
  if (effect.kind === 'RELEASE_FOR_TWO' && (!effect.pct || !effect.count)) {
    problems.push(`${where}: RELEASE_FOR_TWO needs a pct of the leaver's value and a count`);
  }

  // A ripple copies a restriction onto other Pokémon, so it needs a restriction to copy and
  // wording that names the right one. Reusing the original's label would tell a club that
  // Garchomp is out injured on the card belonging to Ferrothorn.
  if (effect.spreadTo) {
    if (effectScope(effect.kind) === 'team') {
      problems.push(`${where}: ${effect.kind} is club-wide already and cannot spread`);
    }
    if (isInstant(effect.kind)) {
      problems.push(`${where}: ${effect.kind} happens once and cannot spread`);
    }
    if (!effect.spreadLabel || !effect.spreadLiftedMessage) {
      problems.push(`${where}: a spreading effect needs spreadLabel and spreadLiftedMessage`);
    }
  }
  return problems;
}

export function pickWeighted<T extends { weight: number }>(
  items: T[],
  random = Math.random,
): T | null {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return null;

  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

// --- resolving a template against one club ------------------------------------------------------

/** An option as offered, with its text rendered and its cost settled. */
export interface StoredOption {
  key: string;
  label: string;
  detail: string;
  default: boolean;
  available: boolean;
  unavailableReason?: string;
  cost: number;
  effects: StoredEffect[];
}

export interface StoredEffect {
  kind: EffectKind;
  pokemonSlug: string | null;
  params: EffectParams;
  matches: number;
  rounds: number;
  label: string;
  liftedMessage: string;
}

function resolveTarget(
  context: EventContext,
  macro: string | undefined,
  triggerSubject: string | null,
  random: () => number,
): string | null {
  const starters = context.squad.filter((member) => member.starter);
  switch (macro) {
    case '@trigger':
      return triggerSubject;
    case '@mostValuableStarter':
      return starters[0]?.pokemonSlug ?? null;
    case '@cheapestStarter':
      return starters[starters.length - 1]?.pokemonSlug ?? null;
    case '@randomStarter':
      return starters.length ? starters[Math.floor(random() * starters.length)].pokemonSlug : null;
    case '@captain':
      return context.squad.find((member) => member.captain)?.pokemonSlug ?? null;
    default:
      return null;
  }
}

function resolveType(
  context: EventContext,
  macro: string | undefined,
  random: () => number,
): string | null {
  if (!macro) return null;
  if (!macro.startsWith('@')) return macro;

  if (macro === '@mostOwnedType') {
    const counts = new Map<string, number>();
    for (const member of context.squad) {
      for (const type of member.types) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ranked[0]?.[0] ?? null;
  }
  if (macro === '@randomOwnedType') {
    return context.ownedTypes.length
      ? context.ownedTypes[Math.floor(random() * context.ownedTypes.length)]
      : null;
  }
  return null;
}

function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

function labelFor(context: EventContext, slug: string | null): string {
  const member =
    context.squad.find((candidate) => candidate.pokemonSlug === slug) ??
    context.freeAgents.find((candidate) => candidate.pokemonSlug === slug);
  return member ? pokemonLabel(member) : 'The squad';
}

/**
 * Which Pokémon a repeating option offers, spread across the squad by value.
 *
 * Offering the three cheapest would make "release one, sign two" a decision about nobody. The
 * best, the middle and the worst is the smallest set that still asks a real question: how much
 * quality are you willing to trade for depth?
 */
function repeatTargets(
  option: OptionSpec,
  context: EventContext,
  subject: string | null,
): (string | null)[] {
  if (option.repeat !== '@starters') return [subject];

  // `context.squad` arrives sorted by value, richest first.
  const starters = context.squad.filter((member) => member.starter);
  if (starters.length === 0) return [];

  const wanted = Math.max(1, Math.min(option.repeatMax ?? 3, starters.length));
  const picks = new Set<string>();
  for (let i = 0; i < wanted; i += 1) {
    const at = wanted === 1 ? 0 : Math.round((i * (starters.length - 1)) / (wanted - 1));
    picks.add(starters[at].pokemonSlug);
  }
  return [...picks];
}

/** Free agents this club could actually be handed, cheapest decision first. */
function withinBand(context: EventContext, value: number, band: number): string[] {
  const reach = (value * band) / 100;
  return context.freeAgents
    .filter((agent) => Math.abs(agent.marketValue - value) <= reach)
    .sort((a, b) => Math.abs(a.marketValue - value) - Math.abs(b.marketValue - value))
    .map((agent) => agent.pokemonSlug);
}

/** The best free agents at or under a ceiling — what a fraction of a Pokémon's value buys. */
function underCeiling(context: EventContext, ceiling: number, count: number): string[] {
  return context.freeAgents
    .filter((agent) => agent.marketValue <= ceiling)
    .sort((a, b) => b.marketValue - a.marketValue)
    .slice(0, count)
    .map((agent) => agent.pokemonSlug);
}

function valueOf(context: EventContext, slug: string | null): number {
  return context.squad.find((candidate) => candidate.pokemonSlug === slug)?.marketValue ?? 0;
}

function costOf(context: EventContext, option: OptionSpec, subject: string | null): number {
  if (!option.cost) return 0;
  const { kind, pct, min } = option.cost;
  const base = kind === 'CASH_PCT' ? Math.max(0, context.cash) : valueOf(context, subject);
  return Math.max(min ?? 0, roundTo((base * pct) / 100, 100));
}

/**
 * Turns a template into the concrete offer one club sees.
 *
 * Everything variable is settled here — which Pokémon, which type, how many Pokédollars — so the
 * row on disk is a complete record of what was offered, and resolution needs nothing but the row.
 */
export function materialise(
  template: EventTemplate,
  context: EventContext,
  triggerSubject: string | null,
  random = Math.random,
): { description: string; subject: string | null; options: StoredOption[] } {
  const subject = resolveTarget(context, template.target, triggerSubject, random);
  const templateType = resolveType(context, template.options.flatMap((o) => o.effects).find((e) => e.type)?.type, random);

  const baseVars: Record<string, string> = {
    team: context.teamName,
    pokemon: labelFor(context, subject),
    ...(templateType ? { type: templateType } : {}),
  };

  const options = template.options.flatMap((option) => {
    const targets = repeatTargets(option, context, subject);
    return targets
      .map((optionSubject) =>
        offerOption(template, option, context, optionSubject, triggerSubject, baseVars, random),
      )
      .filter((offered): offered is StoredOption => offered !== null);
  });

  return { description: render(template.description, baseVars), subject, options };
}


/**
 * One option as this club sees it: text rendered, cost settled, arrivals named.
 *
 * Effects are resolved before the wording is, because an option that hands over a Pokémon can
 * only describe itself once it knows which Pokémon — "swap him for Ferrothorn" is the offer, and
 * "swap him for someone" is not.
 */
/**
 * How hard this event lands on this club.
 *
 * Two dials multiplied together: the league's own `eventSeverity`, which is the one number to
 * turn when a season says the deck is too harsh, and the template's `severityMult` for landing
 * on a captain. Both scale what an option costs and how long its consequences last — quantities
 * that unambiguously mean "worse" when they are bigger. Value percentages and one-off payments
 * are left alone, because a scaler that cannot tell a gain from a loss would make some events
 * kinder the harsher the league was set.
 */
function severityFor(
  template: EventTemplate,
  context: EventContext,
  subject: string | null,
): number {
  const captain = context.squad.find((member) => member.captain);
  const onCaptain = subject !== null && captain?.pokemonSlug === subject;
  const multiplier = onCaptain ? (template.severityMult?.captain ?? 1) : 1;
  return (context.severity / 100) * multiplier;
}

/** Scales a quantity, never rounding a real consequence away to nothing. */
function scale(value: number, factor: number, step: number): number {
  if (value === 0 || factor === 1) return value;
  return Math.max(step, roundTo(value * factor, step));
}

/**
 * Milder copies of an effect, on other members of the starting lineup.
 *
 * Football Manager's squad hierarchy is the model: upsetting the Pokémon the rest of the squad
 * takes its lead from sends the trouble outward. The copies are chosen here, at draw time, so
 * the event that lands is the event the club read.
 */
function ripples(
  effect: EffectSpecJson,
  head: StoredEffect,
  context: EventContext,
  subject: string | null,
  vars: Record<string, string>,
  random: () => number,
): StoredEffect[] {
  if (effect.spreadTo !== 'starters' || head.matches <= 0) return [];

  const others = context.squad.filter(
    (member) => member.starter && member.pokemonSlug !== subject,
  );
  const wanted = Math.min(effect.spreadCount ?? 2, others.length);

  const pool = [...others];
  const picked: typeof others = [];
  for (let i = 0; i < wanted; i += 1) {
    picked.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }

  const matches = Math.max(1, Math.round((head.matches * (effect.spreadPct ?? 50)) / 100));
  return picked.map((member) => {
    const rippleVars = { ...vars, pokemon: pokemonLabel(member) };
    return {
      ...head,
      pokemonSlug: member.pokemonSlug,
      matches,
      label: render(effect.spreadLabel ?? effect.label ?? '', rippleVars),
      liftedMessage: render(effect.spreadLiftedMessage ?? effect.liftedMessage ?? '', rippleVars),
    };
  });
}

function offerOption(
  template: EventTemplate,
  option: OptionSpec,
  context: EventContext,
  subject: string | null,
  triggerSubject: string | null,
  baseVars: Record<string, string>,
  random: () => number,
): StoredOption | null {
  const severity = severityFor(template, context, subject);
  const cost = scale(costOf(context, option, subject), severity, 100);
  const vars: Record<string, string> = {
    ...baseVars,
    pokemon: subject ? labelFor(context, subject) : baseVars.pokemon,
    cost: money(cost),
  };

  let shortfall: string | null = null;

  const effects: StoredEffect[] = option.effects.flatMap((effect) => {
    const slug = effect.target
      ? resolveTarget(context, effect.target, triggerSubject, random)
      : subject;
    const type = resolveType(context, effect.type, random);
    const effectVars: Record<string, string> = {
      ...vars,
      pokemon: labelFor(context, slug),
      ...(type ? { type } : {}),
    };

    const params: EffectParams = {};
    if (effect.pct !== undefined) params.pct = effect.pct;
    if (effect.times !== undefined) params.times = effect.times;
    if (effect.count !== undefined) params.count = effect.count;
    if (effect.amount !== undefined) params.amount = effect.amount;
    if (effect.min !== undefined) params.min = effect.min;
    if (effect.item !== undefined) params.item = effect.item;
    if (effect.band !== undefined) params.band = effect.band;
    if (effect.wins !== undefined) params.wins = effect.wins;
    if (effect.outOf !== undefined) params.outOf = effect.outOf;
    if (effect.reward !== undefined) params.reward = effect.reward;
    if (effect.penalty !== undefined) params.penalty = effect.penalty;
    if (effect.returnPct !== undefined) params.returnPct = effect.returnPct;
    if (type) params.type = type;

    // Who arrives is settled here, named in the offer, and frozen onto the row. A pinned
    // arrival can still be signed by somebody else before this is answered, which the apply
    // step handles by substituting — but the club is told a name, not a value bracket.
    // Amounts priced in wins settle here, against the tier this club is actually playing in.
    const perWin = winReward(context.tierKey, 1);
    if (effect.amountWins !== undefined) params.amount = roundTo(perWin * effect.amountWins, 100);
    if (effect.rewardWins !== undefined) params.reward = roundTo(perWin * effect.rewardWins, 100);
    if (effect.penaltyWins !== undefined) {
      params.penalty = roundTo(perWin * effect.penaltyWins, 100);
    }
    // Money locked away is a share of the balance, floored, like every other charge in the deck.
    if (effect.kind === 'ESCROW' && effect.pct !== undefined) {
      params.amount = cashCost(context.cash, { pct: effect.pct, min: effect.min });
    }
    if (effect.item !== undefined) effectVars.item = effect.item;
    effectVars.amount = money(params.amount ?? 0);
    effectVars.reward = money(params.reward ?? 0);
    effectVars.penalty = money(params.penalty ?? 0);
    effectVars.back = money(
      Math.round(((params.amount ?? 0) * (params.returnPct ?? 100)) / 100),
    );

    const worth = valueOf(context, slug);
    if (effect.kind === 'SWAP_OFFER') {
      const candidates = withinBand(context, worth, effect.band ?? 25);
      if (candidates.length === 0) shortfall = 'Nobody of comparable value is available.';
      params.slug = candidates[0];
      params.amount = worth;
      effectVars.incoming = labelFor(context, candidates[0] ?? null);
    }
    if (effect.kind === 'RELEASE_FOR_TWO') {
      const count = effect.count ?? 2;
      const ceiling = Math.round((worth * (effect.pct ?? 40)) / 100);
      const candidates = underCeiling(context, ceiling, count);
      if (candidates.length < count) {
        shortfall = `The market has only ${candidates.length} free agent${candidates.length === 1 ? '' : 's'} in range.`;
      }
      params.slugs = candidates;
      params.amount = ceiling;
      effectVars.incoming = listOf(candidates.map((candidate) => labelFor(context, candidate)));
    }

    // A wager lasts exactly as long as the window it names, and severity does not get to
    // shorten or lengthen a bet the club agreed to in those terms.
    const wager = effect.kind === 'PLEDGE';
    if (wager && params.penalty !== undefined) {
      params.penalty = scale(params.penalty, severity, 100);
    }

    const head: StoredEffect = {
      kind: effect.kind as EffectKind,
      // Team-wide effects carry no slug even when the event is about one Pokémon.
      pokemonSlug: effect.kind === 'TYPE_BAN' || effect.kind === 'TYPE_VALUE_SHIFT' ? null : slug,
      params,
      matches: wager ? (effect.outOf ?? 0) : scale(effect.matches ?? 0, severity, 1),
      rounds: effect.rounds ?? 0,
      label: render(effect.label ?? '', effectVars),
      liftedMessage: render(effect.liftedMessage ?? '', effectVars),
    };

    return [head, ...ripples(effect, head, context, slug, vars, random)];
  });

  // An option about a Pokémon that does not exist is not an option at all.
  if (option.repeat && !subject) return null;

  const incoming = effects.find((effect) => effect.params.slug || effect.params.slugs);
  const money0 = effects.find(
    (effect) => effect.params.amount || effect.params.reward || effect.params.penalty,
  )?.params;
  const item = effects.find((effect) => effect.params.item)?.params.item;
  const vars2 = {
    ...vars,
    incoming: incoming
      ? incoming.params.slugs
        ? listOf(incoming.params.slugs.map((slug) => labelFor(context, slug)))
        : labelFor(context, incoming.params.slug ?? null)
      : '',
    ...(item ? { item } : {}),
    amount: money(money0?.amount ?? 0),
    reward: money(money0?.reward ?? 0),
    penalty: money(money0?.penalty ?? 0),
    back: money(Math.round(((money0?.amount ?? 0) * (money0?.returnPct ?? 100)) / 100)),
  };

  const unmet = !meetsRequires(context, option.requires);
  return {
    key: option.repeat && subject ? `${option.key}:${subject}` : option.key,
    label: render(option.label, vars2),
    detail: render(option.detail, vars2),
    default: option.default === true,
    available: !unmet && shortfall === null,
    ...(unmet
      ? { unavailableReason: 'Not available to your club right now.' }
      : shortfall
        ? { unavailableReason: shortfall }
        : {}),
    cost,
    effects,
  };
}

/** "A", "A and B", "A, B and C" — for naming what arrives without reading like a database. */
function listOf(items: string[]): string {
  if (items.length === 0) return 'nobody';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// --- drawing ------------------------------------------------------------------------------------

export async function pendingEvent(leagueId: string, teamId: string) {
  return db.leagueEvent.findFirst({
    where: { leagueId, teamId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });
}

/** The template keys this club has seen lately, newest first — for cooldowns. */
async function recentKeys(leagueId: string, teamId: string): Promise<string[]> {
  const rows = await db.leagueEvent.findMany({
    where: { leagueId, teamId, status: { not: 'NOTICE' } },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { templateKey: true },
  });
  return rows.map((row) => row.templateKey);
}

function eligible(
  deck: EventTemplate[],
  context: EventContext,
  recent: string[],
  scope: 'team' | 'league',
): { template: EventTemplate; subject: string | null; triggered: boolean }[] {
  return deck
    .filter((template) => template.scope === scope)
    .filter((template) => {
      const seenAt = recent.indexOf(template.key);
      return seenAt === -1 || seenAt >= (template.cooldown ?? 0);
    })
    .filter((template) => meetsRequires(context, template.requires))
    .map((template) => {
      const trigger = fires(context, template.trigger);
      return { template, subject: trigger.subject, triggered: trigger.fired };
    })
    // A template that declares a trigger is *only* eligible when that trigger has fired —
    // "the Pokémon you forgot about" is meaningless drawn at random.
    .filter((candidate) => !candidate.template.trigger || candidate.triggered);
}

/**
 * Draws this club's next event if one is due.
 *
 * Lazy and idempotent: called from whichever page the manager happens to open. The countdown is
 * claimed with a guarded UPDATE — the same shape that makes two people racing for one Pokémon
 * safe — so two page loads landing together cannot both draw.
 */
export async function ensurePendingEvent(
  leagueId: string,
  teamId: string,
  random = Math.random,
): Promise<{ id: string } | null> {
  const league = await db.league.findUnique({ where: { id: leagueId } });
  if (!league || league.status !== 'ACTIVE') return null;

  const config = parseConfig(league.config);
  if (!config.eventsEnabled) return null;

  if (await pendingEvent(leagueId, teamId)) return null;

  const spread = Math.round(config.eventJitter);
  const next =
    Math.max(1, Math.round(config.eventEveryMatches)) +
    (spread > 0 ? Math.floor(random() * (spread * 2 + 1)) - spread : 0);

  const claimed = await db.team.updateMany({
    where: { id: teamId, leagueId, eventCountdown: { lte: 0 } },
    data: { eventCountdown: Math.max(1, next) },
  });
  if (claimed.count !== 1) return null;

  const context = await buildContext(leagueId, teamId);
  if (!context) return null;

  const deck = loadDeck();
  const problems = validateDeck(deck);
  if (problems.length > 0) {
    throw new EventError(`data/events.json is not safe to draw from: ${problems[0]}`);
  }

  const candidates = eligible(deck, context, await recentKeys(leagueId, teamId), 'team');
  const triggered = candidates.filter((candidate) => candidate.triggered);
  const pool = triggered.length > 0 ? triggered : candidates;
  if (pool.length === 0) return null; // A quiet spell is a legitimate outcome.

  const chosen = pickWeighted(
    pool.map((candidate) => ({ ...candidate, weight: candidate.template.weight })),
    random,
  );
  if (!chosen) return null;

  return createEvent({
    leagueId,
    teamId,
    round: league.round,
    template: chosen.template,
    context,
    triggerSubject: chosen.subject,
    random,
  });
}

/**
 * Writes the event, or applies a virtue outright.
 *
 * A deck tuned to take things away needs somewhere for the occasional good day to come from.
 * When a virtue fires there is nothing to decide — it is news, not a problem — so it resolves
 * itself and never blocks anybody.
 */
async function createEvent(input: {
  leagueId: string;
  teamId: string;
  round: number;
  template: EventTemplate;
  context: EventContext;
  triggerSubject: string | null;
  random: () => number;
}): Promise<{ id: string }> {
  const { template, context, random } = input;
  const offer = materialise(template, context, input.triggerSubject, random);

  const virtueChance = template.virtue ? (template.virtueChance ?? 0) : 0;
  const isVirtue = virtueChance > 0 && random() * 100 < virtueChance;

  return db.$transaction(async (tx) => {
    if (isVirtue && template.virtue) {
      const virtue = materialise(
        { ...template, options: [], description: template.virtue.description },
        context,
        input.triggerSubject,
        random,
      );
      const event = await tx.leagueEvent.create({
        data: {
          leagueId: input.leagueId,
          teamId: input.teamId,
          round: input.round,
          templateKey: `${template.key}:virtue`,
          title: template.virtue.title,
          description: virtue.description,
          detail: JSON.stringify({ virtue: true, subject: offer.subject }),
          status: 'RESOLVED',
          choices: '[]',
          choiceKey: 'virtue',
          resolvedAt: new Date(),
        },
      });

      const effects = materialise(
        { ...template, options: [{ key: 'virtue', label: '', detail: '', effects: template.virtue.effects }] },
        context,
        input.triggerSubject,
        random,
      );
      for (const effect of effects.options[0].effects) {
        await applyEffect(tx, { ...input, eventId: event.id }, effect);
      }
      return { id: event.id };
    }

    const event = await tx.leagueEvent.create({
      data: {
        leagueId: input.leagueId,
        teamId: input.teamId,
        round: input.round,
        templateKey: template.key,
        title: template.title,
        description: offer.description,
        detail: JSON.stringify({
          subject: offer.subject,
          delegable: template.delegable !== false,
          triggered: input.triggerSubject !== null,
        }),
        status: 'PENDING',
        choices: JSON.stringify(offer.options),
      },
    });

    await audit(tx, {
      leagueId: input.leagueId,
      action: 'EVENT_DRAWN',
      detail: { eventId: event.id, teamId: input.teamId, templateKey: template.key },
    });

    return { id: event.id };
  });
}

/** One league-wide shock, offered to every club to answer for itself. */
export async function drawLeagueEvent(
  leagueId: string,
  round: number,
  random = Math.random,
): Promise<number> {
  const league = await db.league.findUnique({ where: { id: leagueId }, include: { teams: true } });
  if (!league) return 0;

  const config = parseConfig(league.config);
  if (!config.eventsEnabled) return 0;

  const deck = loadDeck();
  let drawn = 0;

  for (const team of league.teams) {
    if (await pendingEvent(leagueId, team.id)) continue;

    const context = await buildContext(leagueId, team.id);
    if (!context) continue;

    const candidates = eligible(deck, context, await recentKeys(leagueId, team.id), 'league');
    if (candidates.length === 0) continue;

    const chosen = pickWeighted(
      candidates.map((candidate) => ({ ...candidate, weight: candidate.template.weight })),
      random,
    );
    if (!chosen) continue;

    await createEvent({
      leagueId,
      teamId: team.id,
      round,
      template: chosen.template,
      context,
      triggerSubject: chosen.subject,
      random,
    });
    drawn += 1;
  }

  return drawn;
}

// --- answering ----------------------------------------------------------------------------------

/**
 * Makes sure the Pokémon an event promised are actually still there to hand over.
 *
 * An offer is frozen at draw time but the free agent market is not, so between reading "swap him
 * for Ferrothorn" and clicking it, somebody else can have signed Ferrothorn. Rather than fail —
 * which would punish a manager for thinking about it — the nearest equivalent is substituted and
 * the swap goes through. What was promised was a Pokémon of that standing, and that is what
 * arrives.
 */
async function secureArrivals(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; wanted: string[]; count: number; near?: number; under?: number },
): Promise<string[]> {
  const pool = await tx.ownership.findMany({
    where: { leagueId: input.leagueId, teamId: null, pokemon: { legal: true } },
    select: { pokemonSlug: true, marketValue: true },
  });
  const free = new Map(pool.map((row) => [row.pokemonSlug, row.marketValue]));

  const taken = input.wanted.filter((slug) => free.has(slug)).slice(0, input.count);
  if (taken.length >= input.count) return taken;

  const chosen = new Set(taken);
  const substitutes = pool
    .filter((row) => !chosen.has(row.pokemonSlug))
    .filter((row) => (input.under === undefined ? true : row.marketValue <= input.under))
    .sort((a, b) =>
      input.near === undefined
        ? b.marketValue - a.marketValue
        : Math.abs(a.marketValue - input.near) - Math.abs(b.marketValue - input.near),
    );

  for (const row of substitutes) {
    if (chosen.size >= input.count) break;
    chosen.add(row.pokemonSlug);
  }
  return [...chosen];
}

async function applyEffect(
  tx: Parameters<typeof addEffect>[0],
  input: { leagueId: string; teamId: string; round: number; eventId: string },
  effect: StoredEffect,
): Promise<void> {
  if (isInstant(effect.kind)) {
    switch (effect.kind) {
      case 'CASH':
        await chargeForEvent(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          amount: effect.params.amount ?? 0,
          description: effect.label || 'Event',
          eventId: input.eventId,
          round: input.round,
        });
        return;
      case 'CASH_PCT': {
        const team = await tx.team.findUniqueOrThrow({
          where: { id: input.teamId },
          select: { cash: true },
        });
        await chargeForEvent(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          amount: -cashCost(team.cash, effect.params),
          description: effect.label || 'Event',
          eventId: input.eventId,
          round: input.round,
        });
        return;
      }
      case 'VALUE_MOVE':
        if (effect.pokemonSlug) {
          await moveValue(tx, {
            leagueId: input.leagueId,
            teamId: input.teamId,
            pokemonSlug: effect.pokemonSlug,
            pct: effect.params.pct ?? 0,
            round: input.round,
          });
        }
        return;
      case 'SWAP_OFFER': {
        const leaving = effect.pokemonSlug;
        if (!leaving) return;
        const [incoming] = await secureArrivals(tx, {
          leagueId: input.leagueId,
          wanted: effect.params.slug ? [effect.params.slug] : [],
          count: 1,
          near: effect.params.amount,
        });
        if (!incoming) {
          throw new EventError('There is nobody left in the market to take. Choose another way.');
        }
        // Release first: the squad is never actually short, because the arrival lands in the
        // same transaction, and going the other way round would need room this club may not have.
        await releaseToMarket(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: leaving,
          proceeds: 0,
          type: 'EVENT',
          skipSquadMin: true,
        });
        await claimFreeAgent(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: incoming,
          price: 0,
          type: 'EVENT',
        });
        return;
      }
      case 'RELEASE_FOR_TWO': {
        const leaving = effect.pokemonSlug;
        if (!leaving) return;
        const count = effect.params.count ?? 2;
        const arrivals = await secureArrivals(tx, {
          leagueId: input.leagueId,
          wanted: effect.params.slugs ?? [],
          count,
          under: effect.params.amount,
        });
        if (arrivals.length < count) {
          throw new EventError('The market has dried up since this was offered. Choose another way.');
        }
        await releaseToMarket(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: leaving,
          proceeds: 0,
          type: 'EVENT',
          skipSquadMin: true,
        });
        for (const slug of arrivals) {
          await claimFreeAgent(tx, {
            leagueId: input.leagueId,
            teamId: input.teamId,
            pokemonSlug: slug,
            price: 0,
            type: 'EVENT',
          });
        }
        return;
      }
      case 'TYPE_VALUE_SHIFT':
        if (effect.params.type) {
          await moveTypeValue(tx, {
            leagueId: input.leagueId,
            teamId: input.teamId,
            type: effect.params.type,
            pct: effect.params.pct ?? 0,
            round: input.round,
          });
        }
        return;
      default:
        return;
    }
  }

  // Locked money leaves now and comes back when the round it names closes.
  if (effect.kind === 'ESCROW') {
    await chargeForEvent(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      amount: -(effect.params.amount ?? 0),
      description: effect.label || 'Event',
      eventId: input.eventId,
      round: input.round,
    });
  }

  const params =
    effect.kind === 'PLEDGE'
      ? { ...effect.params, won: 0, note: effect.label }
      : effect.params;

  await addEffect(tx, {
    leagueId: input.leagueId,
    teamId: input.teamId,
    pokemonSlug: effect.pokemonSlug,
    kind: effect.kind,
    params,
    matches: effect.matches,
    round: input.round,
    untilRound: effect.rounds > 0 ? input.round + effect.rounds : null,
    label: effect.label,
    liftedMessage: effect.liftedMessage,
    sourceEventId: input.eventId,
  });
}

export function parseChoices(json: string): StoredOption[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Takes an option. Charges for it, puts its consequences in force, and unblocks the club. */
export async function resolveEvent(input: {
  eventId: string;
  teamId: string;
  choiceKey: string;
  actorUserId: string;
  status?: 'RESOLVED' | 'DELEGATED' | 'FORCED';
}) {
  return db.$transaction(async (tx) => {
    const event = await tx.leagueEvent.findUniqueOrThrow({ where: { id: input.eventId } });
    if (event.teamId !== input.teamId) throw new EventError('That event is not yours to answer.');
    if (event.status !== 'PENDING') throw new EventError('That event has already been answered.');

    const options = parseChoices(event.choices);
    const option = options.find((candidate) => candidate.key === input.choiceKey);
    if (!option) throw new EventError('That option is no longer on the table.');
    if (!option.available) throw new EventError(option.unavailableReason ?? 'That option is not open to you.');

    const league = await tx.league.findUniqueOrThrow({ where: { id: event.leagueId } });

    if (option.cost > 0) {
      await chargeForEvent(tx, {
        leagueId: event.leagueId,
        teamId: input.teamId,
        amount: -option.cost,
        description: `${event.title} — ${option.label}`,
        eventId: event.id,
        round: league.round,
      });
    }

    for (const effect of option.effects) {
      await applyEffect(
        tx,
        { leagueId: event.leagueId, teamId: input.teamId, round: league.round, eventId: event.id },
        effect,
      );
    }

    await tx.leagueEvent.update({
      where: { id: event.id },
      data: {
        status: input.status ?? 'RESOLVED',
        choiceKey: option.key,
        resolvedAt: new Date(),
        resolvedById: input.actorUserId,
      },
    });

    await audit(tx, {
      leagueId: event.leagueId,
      actorUserId: input.actorUserId,
      action: 'EVENT_RESOLVED',
      detail: { eventId: event.id, choiceKey: option.key, cost: option.cost },
    });

    return { title: event.title, option: option.label, cost: option.cost };
  });
}

/**
 * Hands the decision to your assistant coach.
 *
 * They pick at random from whatever is open, which is rarely what you would have chosen — the
 * point is that it costs you control rather than money. It is also the guarantee that no club is
 * ever stuck: there is always one button that works.
 */
export async function delegateEvent(input: {
  eventId: string;
  teamId: string;
  actorUserId: string;
  random?: () => number;
}) {
  const random = input.random ?? Math.random;
  const event = await db.leagueEvent.findUniqueOrThrow({ where: { id: input.eventId } });
  if (event.status !== 'PENDING') throw new EventError('That event has already been answered.');

  const detail = JSON.parse(event.detail || '{}');
  if (detail.delegable === false) {
    throw new EventError('This one is yours to decide — your assistant will not touch it.');
  }

  const open = parseChoices(event.choices).filter((option) => option.available);
  if (open.length === 0) throw new EventError('There is nothing your assistant can do here.');

  const pick = open[Math.floor(random() * open.length)];
  return resolveEvent({ ...input, choiceKey: pick.key, status: 'DELEGATED' });
}

/** Commissioner escape hatch: applies the default branch so a stuck league can always move on. */
export async function forceResolveEvent(input: { eventId: string; actorUserId: string }) {
  const event = await db.leagueEvent.findUniqueOrThrow({ where: { id: input.eventId } });
  const league = await db.league.findUniqueOrThrow({ where: { id: event.leagueId } });
  if (league.commissionerId !== input.actorUserId) {
    throw new EventError('Only the commissioner can force an event through.');
  }
  if (!event.teamId) throw new EventError('That event has no club to answer it.');

  const options = parseChoices(event.choices);
  const fallback = options.find((option) => option.default) ?? options.find((option) => option.available);
  if (!fallback) throw new EventError('That event has no option to fall back on.');

  return resolveEvent({
    eventId: event.id,
    teamId: event.teamId,
    choiceKey: fallback.key,
    actorUserId: input.actorUserId,
    status: 'FORCED',
  });
}

export async function getEvents(leagueId: string, take = 10) {
  return db.leagueEvent.findMany({
    where: { leagueId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/** One club's own event history, decisions and lift notices alike. */
export async function getTeamEvents(leagueId: string, teamId: string, take = 20) {
  return db.leagueEvent.findMany({
    where: { leagueId, teamId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}
