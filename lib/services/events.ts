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
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

import { applyPct, roundTo, TIERS } from '../../config/economy.ts';
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
  moveSquadValue,
  moveTypeValue,
  moveValue,
  setValue,
  tickEventEffects,
  type EffectKind,
  type EffectParams,
} from './effects.ts';
import { LISTING_MIN_DAYS, openListing } from './listings.ts';
import { audit } from './money.ts';
import { claimFreeAgent, parseConfig, releaseToMarket } from './ownership.ts';
import {
  buildContext,
  fires,
  meetsRequires,
  requireReason,
  type EventContext,
  type Requires,
  type Trigger,
} from './triggers.ts';

// Resolved at runtime, not from `import.meta.url`: the bundler inlines that as the absolute path
// of the machine that ran `next build`, which is fine on a laptop and wrong in a container.
// `process.cwd()` is the repo root under dev, `next start` and vitest alike.
const DATA_DIR = process.env.PKF_DATA_DIR ?? join(process.cwd(), 'data');

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
  /**
   * `CASH_PCT` is a share of the balance and `VALUE_PCT` a share of one Pokémon's worth — both
   * scale with the club, and both need a `min` so a broke club still feels them. `CASH` is a
   * flat sum, for the handful of costs that are the same however rich you are: replacing a
   * batch of held items costs what it costs.
   */
  kind: 'CASH_PCT' | 'VALUE_PCT' | 'CASH';
  pct?: number;
  min?: number;
  /** `CASH` only: the sum itself. */
  amount?: number;
}

export interface EffectSpecJson {
  kind: string;
  /** Overrides the template's target for this one effect. */
  target?: string;
  matches?: number;
  /** A duration counted in events dealt to this club, rather than in matches played. */
  events?: number;
  rounds?: number;
  pct?: number;
  times?: number;
  count?: number;
  amount?: number;
  min?: number;
  type?: string;
  item?: string;
  /**
   * SWAP_OFFER: how much more the arrival is worth than the Pokémon that left, as a percentage.
   *
   * Standing is matched on tier rather than on value, because the two `marketValue` columns are
   * not the same quantity — an owned Pokémon carries `buyValue` of what was paid, a free agent
   * carries the full shop price. Banding one against the other quietly traded a Pokémon for one
   * roughly half its worth and called them equals.
   */
  bonusPct?: number;
  /** GIFT_POKEMON: the market tiers the prize may be drawn from. */
  tiers?: string[];
  /** INJURY_ROLL: the table, one entry per equally likely outcome, in matches out. */
  faces?: number[];
  /** UPKEEP: charge it only on the matches the club loses. */
  onLoss?: boolean;
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
   * Keeps only the ripples and drops the copy that would have landed on the subject.
   *
   * For an effect whose subject is on its way out of the club: the squad it leaves behind is
   * what the consequence is about, and a restriction written against a Pokémon another club now
   * owns is a row nobody can ever serve. The ripple pool is the squad as it stands at draw time,
   * so a Pokémon arriving in the same breath is never in it.
   */
  spreadOnly?: boolean;
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
  /**
   * A second Pokémon the event is about, for the ones that concern a pair.
   *
   * Resolved like `target` and rendered as `{other}`, so a template can name both sides of a
   * falling-out in its description and then offer a branch about each.
   */
  otherTarget?: string;
  /**
   * How the event should read on screen. "fortune" is good news arriving — an opportunity rather
   * than a problem — and the UI shows it in gold instead of the ordinary card.
   */
  tone?: 'fortune';
  virtueChance?: number;
  virtue?: { title: string; description: string; effects: EffectSpecJson[] };
  /**
   * News rather than a question: it applies itself and blocks nobody.
   *
   * Most of the deck is a decision, because an event nobody has to think about teaches people to
   * stop reading the feed. The exception is a change to the rules everybody plays under — a club
   * does not get to opt out of a regulation, and pretending it might is a worse lie than having
   * no choice at all. An announcement carries `effects` where a decision carries `options`.
   */
  announcement?: boolean;
  effects?: EffectSpecJson[];
  options: OptionSpec[];
}

let cache: EventTemplate[] | null = null;

export function loadDeck(): EventTemplate[] {
  if (!cache) {
    const file = JSON.parse(readFileSync(join(DATA_DIR, 'events.json'), 'utf8'));
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
    if (template.announcement) {
      if (!template.effects?.length) {
        problems.push(`${where}: an announcement needs effects — it is news, and news has to do something`);
      }
      if (template.options.length > 0) {
        problems.push(`${where}: an announcement has no options; it applies itself`);
      }
      for (const effect of template.effects ?? []) {
        problems.push(...checkEffect(effect, `${where}, announcement`));
      }
      for (const effect of template.virtue?.effects ?? []) {
        problems.push(...checkEffect(effect, `${where}, virtue`));
      }
      continue;
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
      if (option.cost?.kind === 'CASH') {
        if (!option.cost.amount) {
          problems.push(`${where}, option "${option.key}": a flat cost needs an amount`);
        }
      } else if (option.cost && option.cost.min === undefined) {
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
    if (!effect.matches && !effect.events && !effect.rounds && effect.kind !== 'PLEDGE') {
      problems.push(`${where}: effect ${effect.kind} needs a duration in matches, events or rounds`);
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
    // Deliberately exempt from the floor every other percentage carries. A floor is there so a
    // broke club still feels a charge, and locked money is not a charge — it comes back, with
    // interest. Applied here it does the opposite of its job: a club with ₽30,000 would have to
    // commit two thirds of everything it has to an opportunity the rich take 20% of, and an
    // event charge may go negative, so the floor invites a club to borrow in order to invest.
    // Keep the poor out of a bond with `requires.minCash`, not by making their stake larger.
    if ((!effect.amount && !effect.amountWins && !effect.pct) || !effect.returnPct || !effect.rounds) {
      problems.push(`${where}: ESCROW needs an amount, a returnPct and a duration in rounds`);
    }
  }
  if (effect.kind === 'SWAP_OFFER' && !effect.bonusPct) {
    problems.push(`${where}: SWAP_OFFER needs a bonusPct — what the arrival gains over the leaver`);
  }
  if (effect.kind === 'RELEASE_FOR_TWO' && (!effect.pct || !effect.count)) {
    problems.push(`${where}: RELEASE_FOR_TWO needs a pct of the leaver's value and a count`);
  }
  // A club-wide value move with no percentage is a branch that silently does nothing to
  // everybody, which is the hardest kind of dead option to notice.
  // A listing runs on the clock, and `listings.ts` will not let one run for less than its
  // minimum however the deck is written — but a template that says nothing about how long is a
  // template whose wording cannot tell the club either.
  if (effect.kind === 'LIST_FOR_SALE' && (effect.count ?? 0) < LISTING_MIN_DAYS) {
    problems.push(
      `${where}: LIST_FOR_SALE needs a count of at least ${LISTING_MIN_DAYS} days on the board`,
    );
  }
  if (effect.kind === 'INJURY_ROLL' && (effect.faces?.length ?? 0) < 2) {
    problems.push(`${where}: INJURY_ROLL needs a table of at least two outcomes`);
  }
  if (effect.kind === 'GIFT_POKEMON' && !effect.tiers?.length) {
    problems.push(`${where}: GIFT_POKEMON needs the tiers its prize may come from`);
  }
  if (effect.kind === 'SQUAD_VALUE_SHIFT' && !effect.pct) {
    problems.push(`${where}: SQUAD_VALUE_SHIFT needs a pct`);
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
  if (effect.spreadOnly && !effect.spreadTo) {
    problems.push(`${where}: spreadOnly needs a spreadTo, or the effect reaches nobody at all`);
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
  events: number;
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
    // The two the club leans on hardest — and so the two with something to fall out about.
    case '@mostUsed':
      return context.mostUsed[0] ?? null;
    case '@secondMostUsed':
      return context.mostUsed[1] ?? null;
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
/** The tier a squad member was priced in, and the same for an unsigned Pokémon. */
function tierOf(context: EventContext, slug: string | null): string | null {
  return context.squad.find((candidate) => candidate.pokemonSlug === slug)?.tier ?? null;
}

function tierOfAgent(context: EventContext, slug: string | null): string | null {
  return context.freeAgents.find((agent) => agent.pokemonSlug === slug)?.tier ?? null;
}

/**
 * A Pokémon's own tier and the one above it — what a club may be offered in a straight swap.
 *
 * `TIERS` runs best-first, so the rung above is the preceding index. At the top of the market
 * there is nothing above, and S swaps for S.
 */
function sameOrOneAbove(tier: string | null): string[] {
  if (!tier) return [];
  const at = (TIERS as readonly string[]).indexOf(tier);
  if (at < 0) return [tier];
  return at === 0 ? [tier] : [TIERS[at - 1], tier];
}

function inTiers(context: EventContext, tiers: string[]): string[] {
  return context.freeAgents
    .filter((agent) => tiers.includes(agent.tier))
    .map((agent) => agent.pokemonSlug);
}

function valueOf(context: EventContext, slug: string | null): number {
  return context.squad.find((candidate) => candidate.pokemonSlug === slug)?.marketValue ?? 0;
}

function costOf(context: EventContext, option: OptionSpec, subject: string | null): number {
  if (!option.cost) return 0;
  const { kind, pct, min, amount } = option.cost;
  if (kind === 'CASH') return Math.max(0, Math.round(amount ?? 0));
  const base = kind === 'CASH_PCT' ? Math.max(0, context.cash) : valueOf(context, subject);
  return Math.max(min ?? 0, roundTo((base * (pct ?? 0)) / 100, 100));
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
  /**
   * Variables settled outside this club, for a shock the whole league is answering. A regulation
   * that hit Water-types hit Water-types everywhere; resolving the macro per club would give
   * every manager their own private regulation and nobody anything to talk about.
   */
  shared: { type?: string } = {},
): { description: string; subject: string | null; options: StoredOption[] } {
  const subject = resolveTarget(context, template.target, triggerSubject, random);
  const authoredType = [...template.options.flatMap((o) => o.effects), ...(template.effects ?? [])]
    .find((effect) => effect.type)?.type;
  const templateType = shared.type ?? resolveType(context, authoredType, random);

  const other = resolveTarget(context, template.otherTarget, null, random);

  const baseVars: Record<string, string> = {
    team: context.teamName,
    pokemon: labelFor(context, subject),
    ...(other ? { other: labelFor(context, other) } : {}),
    ...(templateType ? { type: templateType } : {}),
  };

  // An announcement has one implicit branch: what happened. Running it through the same path
  // keeps every placeholder, every severity scale and every ripple working identically.
  const authored: OptionSpec[] = template.announcement
    ? [{ key: 'announcement', label: template.title, detail: '', effects: template.effects ?? [] }]
    : template.options;

  const options = authored.flatMap((option) => {
    const targets = repeatTargets(option, context, subject);
    return targets
      .map((optionSubject) =>
        offerOption(template, option, context, optionSubject, triggerSubject, baseVars, random, shared),
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
  shared: { type?: string } = {},
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
    const type = shared.type ?? resolveType(context, effect.type, random);
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
    if (effect.bonusPct !== undefined) params.bonusPct = effect.bonusPct;
    if (effect.tiers !== undefined) params.tiers = effect.tiers;
    if (effect.onLoss !== undefined) params.onLoss = effect.onLoss;
    // Severity lengthens an absence like any other duration, so the published table is the
    // table this club is actually rolling on rather than the one in the file.
    if (effect.faces !== undefined) {
      params.faces = effect.faces.map((face) => scale(face, severity, 1));
      effectVars.ladder = ladderOf(params.faces);
    }
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
    // So is an instalment. A flat instalment set against a percentage lump sum inverts as a club
    // gets richer — the payment plan becomes the cheap option for exactly the clubs that could
    // have paid outright — so both ends of the same decision are priced off the same balance.
    if (effect.kind === 'UPKEEP' && effect.pct !== undefined) {
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
    // A sale is quoted at what the Pokémon is worth the moment the offer is made, and paid at
    // that same figure — the club is answering the price it was shown, not a later one.
    if (effect.kind === 'SELL_TO_MARKET') params.amount = worth;
    // What the board will ask: what it is worth, plus whatever it came in demanding.
    if (effect.kind === 'LIST_FOR_SALE') {
      params.amount = roundTo((worth * (100 + (effect.pct ?? 0))) / 100, 100);
    }
    // The prize is named as a tier, never as a Pokémon — but a tier with nobody left in it is
    // not a prize, so the branch closes rather than promising what the market cannot give.
    if (effect.kind === 'GIFT_POKEMON') {
      const tiers = effect.tiers ?? [];
      if (!context.freeAgents.some((free) => tiers.includes(free.tier))) {
        shortfall = `There is no ${listOf(tiers)} tier Pokémon left unsigned.`;
      }
    }
    if (effect.kind === 'SWAP_OFFER') {
      const tiers = sameOrOneAbove(tierOf(context, subject));
      const candidates = inTiers(context, tiers);
      if (candidates.length === 0) {
        shortfall = `No unsigned ${listOf(tiers)} tier Pokémon is available to swap for.`;
      }
      const pick = candidates.length ? candidates[Math.floor(random() * candidates.length)] : null;
      params.slug = pick ?? undefined;
      params.amount = worth;
      params.bonusPct = effect.bonusPct ?? 15;
      params.tiers = tiers;
      effectVars.incoming = labelFor(context, pick);
      effectVars.incomingTier = tierOfAgent(context, pick) ?? '';
    }
    if (effect.kind === 'RELEASE_FOR_TWO') {
      const count = effect.count ?? 2;
      const tier = tierOf(context, subject);
      const pool = tier ? inTiers(context, [tier]) : [];
      if (pool.length < count) {
        shortfall = `The market has only ${pool.length} unsigned ${tier ?? ''} tier Pokémon left.`;
      }
      // Which two is settled when the club says yes, not here. The offer is a tier and a count,
      // and the gamble is the whole of it — the same reasoning as GIFT_POKEMON.
      params.count = count;
      params.amount = worth;
      params.pct = effect.pct ?? 50;
      params.tiers = tier ? [tier] : [];
      effectVars.incomingTier = tier ?? '';
    }

    // A wager lasts exactly as long as the window it names, and severity does not get to
    // shorten or lengthen a bet the club agreed to in those terms.
    const wager = effect.kind === 'PLEDGE';
    if (wager && params.penalty !== undefined) {
      params.penalty = scale(params.penalty, severity, 100);
    }

    // An honour rule about something this Pokémon physically cannot do is a box that means
    // nothing, ticked every match for five matches. Attestation only works while every box is
    // a real promise, so the effect is dropped rather than shipped empty.
    if (effect.kind === 'NO_MEGA' && slug) {
      const member = context.squad.find((candidate) => candidate.pokemonSlug === slug);
      if (member && !member.hasMega) return [];
    }

    const head: StoredEffect = {
      kind: effect.kind as EffectKind,
      // A club-wide effect carries no slug even when the event that caused it was about one
      // Pokémon. Asking the vocabulary rather than naming kinds here is what keeps the row
      // honest: the next surface to render a per-Pokémon badge would otherwise put "value
      // moves halved" on Eelektross's card, for a restriction the whole club is under.
      pokemonSlug: effectScope(effect.kind as EffectKind) === 'team' ? null : slug,
      params,
      matches: wager ? (effect.outOf ?? 0) : scale(effect.matches ?? 0, severity, 1),
      events: scale(effect.events ?? 0, severity, 1),
      rounds: effect.rounds ?? 0,
      label: render(effect.label ?? '', effectVars),
      liftedMessage: render(effect.liftedMessage ?? '', effectVars),
    };

    const spread = ripples(effect, head, context, slug, vars, random);
    return effect.spreadOnly ? spread : [head, ...spread];
  });

  // An option about a Pokémon that does not exist is not an option at all.
  if (option.repeat && !subject) return null;

  const incoming = effects.find(
    (effect) => effect.params.slug || effect.params.slugs || effect.params.tiers?.length,
  );
  const money0 = effects.find(
    (effect) => effect.params.amount || effect.params.reward || effect.params.penalty,
  )?.params;
  const item = effects.find((effect) => effect.params.item)?.params.item;
  const faces = effects.find((effect) => effect.params.faces)?.params.faces;
  const vars2 = {
    ...vars,
    incoming: incoming
      ? incoming.params.slugs
        ? listOf(incoming.params.slugs.map((slug) => labelFor(context, slug)))
        : labelFor(context, incoming.params.slug ?? null)
      : '',
    // An offer that pins a name can say what tier that name is; one that pins only a tier says
    // the tier, because that is the whole of what the club is being told.
    incomingTier: incoming?.params.slug
      ? (tierOfAgent(context, incoming.params.slug) ?? '')
      : (incoming?.params.tiers?.[0] ?? ''),
    ...(item ? { item } : {}),
    ...(faces ? { ladder: ladderOf(faces) } : {}),
    amount: money(money0?.amount ?? 0),
    reward: money(money0?.reward ?? 0),
    penalty: money(money0?.penalty ?? 0),
    back: money(Math.round(((money0?.amount ?? 0) * (money0?.returnPct ?? 100)) / 100)),
  };

  // A closed branch says why. The manager can act on half of these — sell somebody, hand the
  // armband to a Pokémon that will keep it — and on the rest it is at least honest.
  const unmet = requireReason(context, option.requires);
  return {
    key: option.repeat && subject ? `${option.key}:${subject}` : option.key,
    label: render(option.label, vars2),
    detail: render(option.detail, vars2),
    default: option.default === true,
    available: unmet === null && shortfall === null,
    ...(unmet ? { unavailableReason: unmet } : shortfall ? { unavailableReason: shortfall } : {}),
    cost,
    effects,
  };
}

/**
 * A published risk ladder, written from the table it describes.
 *
 * Generated rather than authored, because an event that prints odds it does not actually roll
 * on is worse than one that prints nothing: the whole point of showing the table is that the
 * gamble is informed.
 */
function ladderOf(faces: number[]): string {
  const counts = new Map<number, number>();
  for (const face of faces) counts.set(face, (counts.get(face) ?? 0) + 1);

  const parts = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([matches, count]) => {
      const outcome =
        matches === 0
          ? 'nothing at all'
          : matches === 1
            ? 'out for a match'
            : `out for ${matches} matches`;
      return `${outcome} (${count} in ${faces.length})`;
    });
  return listOf(parts);
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

/**
 * The template keys this club has seen lately, newest first — for cooldowns.
 *
 * A virtue is stored as `<key>:virtue`, and it is still that template having happened to this
 * club: the cooldown exists so the same fiction does not come round twice running, and a club
 * whose suspension was dismissed has just had the suspension event. Left unstripped the suffix
 * never matched, so a template whose virtue fired was immediately redrawable.
 */
async function recentKeys(leagueId: string, teamId: string): Promise<string[]> {
  const rows = await db.leagueEvent.findMany({
    where: { leagueId, teamId, status: { not: 'NOTICE' } },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { templateKey: true },
  });
  return rows.map((row) => row.templateKey.replace(/:virtue$/, ''));
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

  const low = Math.max(1, Math.round(config.eventEveryMin));
  const high = Math.max(low, Math.round(config.eventEveryMax));
  const next = low + Math.floor(random() * (high - low + 1));

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
  shared?: { type?: string };
}): Promise<{ id: string }> {
  const { template, context, random } = input;
  const shared = input.shared ?? {};
  const offer = materialise(template, context, input.triggerSubject, random, shared);

  const virtueChance = template.virtue ? (template.virtueChance ?? 0) : 0;
  const isVirtue = virtueChance > 0 && random() * 100 < virtueChance;

  return db.$transaction(async (tx) => {
    // Being dealt this event is what spends a favour measured in events. Done before the row is
    // written so the crisis a club is looking at never counts against itself.
    await tickEventEffects(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      round: input.round,
    });

    if (isVirtue && template.virtue) {
      const virtue = materialise(
        { ...template, announcement: false, options: [], description: template.virtue.description },
        context,
        input.triggerSubject,
        random,
        shared,
      );
      const event = await tx.leagueEvent.create({
        data: {
          leagueId: input.leagueId,
          teamId: input.teamId,
          round: input.round,
          templateKey: `${template.key}:virtue`,
          title: template.virtue.title,
          description: virtue.description,
          // A virtue is always good news, whatever the template it inverted.
          detail: JSON.stringify({ virtue: true, subject: offer.subject, tone: 'fortune' }),
          status: 'RESOLVED',
          choices: '[]',
          choiceKey: 'virtue',
          resolvedAt: new Date(),
        },
      });

      const effects = materialise(
        {
          ...template,
          announcement: false,
          options: [{ key: 'virtue', label: '', detail: '', effects: template.virtue.effects }],
        },
        context,
        input.triggerSubject,
        random,
        shared,
      );
      for (const effect of effects.options[0].effects) {
        await applyEffect(tx, { ...input, eventId: event.id }, effect);
      }
      return { id: event.id };
    }

    // News, not a question. It applies itself and never blocks a club from reporting, because
    // there is nothing for them to answer.
    if (template.announcement) {
      const event = await tx.leagueEvent.create({
        data: {
          leagueId: input.leagueId,
          teamId: input.teamId,
          round: input.round,
          templateKey: template.key,
          title: template.title,
          description: offer.description,
          detail: JSON.stringify({ announcement: true, subject: offer.subject }),
          status: 'RESOLVED',
          choices: '[]',
          choiceKey: 'announcement',
          resolvedAt: new Date(),
        },
      });
      for (const effect of offer.options[0]?.effects ?? []) {
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
          triggered: input.triggerSubject !== null,
          ...(template.tone ? { tone: template.tone } : {}),
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
/**
 * The shock a round closes with: one event, drawn once, answered by everybody.
 *
 * Deliberately not a loop of private draws. A league-scope event is the only thing in the deck
 * that every manager can talk to each other about, and that only works if it is the same event —
 * the same regulation, hitting the same type, on the same evening. So the template is picked
 * once for the league and its shared variables are settled once, then each club gets its own row
 * to deal with in its own squad.
 */
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

  // Every club's situation first: what is eligible for the league is what is eligible for
  // somebody in it, and the shared variables are read off all the squads at once.
  const contexts: { teamId: string; context: EventContext }[] = [];
  for (const team of league.teams) {
    const context = await buildContext(leagueId, team.id);
    if (context) contexts.push({ teamId: team.id, context });
  }
  if (contexts.length === 0) return 0;

  const pool = new Map<string, { template: EventTemplate; weight: number }>();
  for (const { teamId, context } of contexts) {
    for (const candidate of eligible(deck, context, await recentKeys(leagueId, teamId), 'league')) {
      pool.set(candidate.template.key, {
        template: candidate.template,
        weight: candidate.template.weight,
      });
    }
  }
  if (pool.size === 0) return 0;

  const chosen = pickWeighted([...pool.values()], random);
  if (!chosen) return 0;

  const shared = { type: sharedType(contexts.map((entry) => entry.context), random) ?? undefined };

  let drawn = 0;
  for (const { teamId, context } of contexts) {
    // A club already holding a decision is not handed a second one; it will see this in the feed.
    if (await pendingEvent(leagueId, teamId)) continue;
    if (!meetsRequires(context, chosen.template.requires)) continue;

    await createEvent({
      leagueId,
      teamId,
      round,
      template: chosen.template,
      context,
      triggerSubject: null,
      random,
      shared,
    });
    drawn += 1;
  }

  return drawn;
}

/**
 * The type a league-wide shock lands on: whatever the league as a whole owns most of.
 *
 * The meta moving against the thing everybody plays is both the likeliest story and the one that
 * divides a league most sharply — the clubs that built around it are in trouble, and the club
 * that never owned one gets to say so all week.
 */
function sharedType(contexts: EventContext[], random: () => number): string | null {
  const counts = new Map<string, number>();
  for (const context of contexts) {
    for (const member of context.squad) {
      for (const type of member.types) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // A tie at the top is broken by the roll, so a league of two identical squads is not condemned
  // to the same regulation every time it comes round.
  const top = ranked.filter((entry) => entry[1] === ranked[0][1]);
  return top[Math.floor(random() * top.length)][0];
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
  input: {
    leagueId: string;
    wanted: string[];
    count: number;
    near?: number;
    under?: number;
    /** Restricts substitutes to the tiers the offer named, so a swap can't silently downgrade. */
    tiers?: string[];
    /** Draws from the pool at random rather than by value — for an offer that was a gamble. */
    atRandom?: boolean;
  },
): Promise<string[]> {
  const pool = await tx.ownership.findMany({
    where: {
      leagueId: input.leagueId,
      teamId: null,
      pokemon: { legal: true, ...(input.tiers?.length ? { tier: { in: input.tiers } } : {}) },
    },
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
      input.atRandom
        ? Math.random() - 0.5
        : input.near === undefined
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
          tiers: effect.params.tiers,
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

        // The arrival is worth more than what left, by the margin the offer published. A free
        // agent's stored value is a shop price and the leaver's is what this club discovered in
        // it, so the arrival is priced off the leaver rather than carrying the shop's number in.
        const worth = effect.params.amount ?? 0;
        const bonus = effect.params.bonusPct ?? 15;
        if (worth > 0) {
          await setValue(tx, {
            leagueId: input.leagueId,
            teamId: input.teamId,
            pokemonSlug: incoming,
            to: applyPct(worth, bonus),
            round: input.round,
          });
        }
        return;
      }
      case 'RELEASE_FOR_TWO': {
        const leaving = effect.pokemonSlug;
        if (!leaving) return;
        const count = effect.params.count ?? 2;
        const arrivals = await secureArrivals(tx, {
          leagueId: input.leagueId,
          wanted: [],
          count,
          tiers: effect.params.tiers,
          atRandom: true,
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
        // Each arrival is worth a share of the Pokémon that paid for it, so the two of them
        // together are the squad's own value rearranged rather than the shop's numbers walking in.
        const share = Math.round(((effect.params.amount ?? 0) * (effect.params.pct ?? 50)) / 100);
        for (const slug of arrivals) {
          await claimFreeAgent(tx, {
            leagueId: input.leagueId,
            teamId: input.teamId,
            pokemonSlug: slug,
            price: 0,
            type: 'EVENT',
          });
          if (share > 0) {
            await setValue(tx, {
              leagueId: input.leagueId,
              teamId: input.teamId,
              pokemonSlug: slug,
              to: share,
              round: input.round,
            });
          }
        }
        return;
      }
      case 'SELL_TO_MARKET': {
        if (!effect.pokemonSlug) return;
        await releaseToMarket(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: effect.pokemonSlug,
          proceeds: effect.params.amount,
          type: 'EVENT',
          description: effect.label || 'Sold after an event',
        });
        return;
      }
      case 'LIST_FOR_SALE': {
        if (!effect.pokemonSlug) return;
        await openListing(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: effect.pokemonSlug,
          price: effect.params.amount ?? 0,
          // The deck writes this window in days; the board keeps hours, so managers can post
          // something for an afternoon without the deck having to learn fractions.
          hours: effect.params.count ? effect.params.count * 24 : undefined,
          reason: 'EVENT',
        });
        return;
      }
      case 'INJURY_ROLL': {
        if (!effect.pokemonSlug) return;
        const faces = effect.params.faces ?? [];
        if (faces.length === 0) return;
        const matches = faces[Math.floor(Math.random() * faces.length)];

        await tx.leagueEvent.create({
          data: {
            leagueId: input.leagueId,
            teamId: input.teamId,
            round: input.round,
            templateKey: 'roll:injury',
            title: 'The scan came back',
            description:
              matches === 0
                ? `${effect.label} — and there is nothing in it. No absence at all.`
                : `${effect.label} — ${matches} ${matches === 1 ? 'match' : 'matches'} out.`,
            detail: JSON.stringify({ pokemonSlug: effect.pokemonSlug, matches, faces }),
            status: 'NOTICE',
          },
        });
        if (matches === 0) return;

        await addEffect(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: effect.pokemonSlug,
          kind: 'POKEMON_OUT',
          matches,
          round: input.round,
          label: effect.label,
          liftedMessage: effect.liftedMessage,
          sourceEventId: input.eventId,
        });
        return;
      }
      case 'GIFT_POKEMON': {
        const tiers = effect.params.tiers ?? [];
        const available = await tx.ownership.findMany({
          where: { leagueId: input.leagueId, teamId: null, pokemon: { legal: true, tier: { in: tiers } } },
          select: { pokemonSlug: true },
        });
        if (available.length === 0) {
          throw new EventError('The market has been picked clean since this was offered. Take the money.');
        }
        // Rolled here, not at draw time: what the club accepted was a tier and a gamble.
        const prize = available[Math.floor(Math.random() * available.length)];
        await claimFreeAgent(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pokemonSlug: prize.pokemonSlug,
          price: 0,
          type: 'EVENT',
        });
        return;
      }
      case 'SQUAD_VALUE_SHIFT':
        await moveSquadValue(tx, {
          leagueId: input.leagueId,
          teamId: input.teamId,
          pct: effect.params.pct ?? 0,
          round: input.round,
        });
        return;
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
    events: effect.events,
    round: input.round,
    untilRound: effect.rounds > 0 ? input.round + effect.rounds : null,
    label: effect.label,
    liftedMessage: effect.liftedMessage,
    sourceEventId: input.eventId,
  });
}

/**
 * Writes what a club actually did into the feed.
 *
 * Without this an answered event is indistinguishable from an unanswered one: the row in the
 * news panel still reads "Too many new faces", and the decision — the whole point of the
 * feature — leaves no trace anybody else can see. Some branches leave nothing else behind at
 * all: a branch that only costs money would otherwise be paid in silence.
 *
 * The consequences are read off the option's own effect labels, so this stays true to whatever
 * the deck says without knowing anything about particular events.
 */
async function announceOutcome(
  tx: Prisma.TransactionClient,
  input: {
    event: { id: string; leagueId: string; templateKey: string; title: string; detail: string };
    teamId: string;
    round: number;
    option: StoredOption;
  },
): Promise<void> {
  const team = await tx.team.findUnique({
    where: { id: input.teamId },
    select: { name: true },
  });

  const tone = (JSON.parse(input.event.detail || '{}') as { tone?: string }).tone;
  const consequences = input.option.effects.map((effect) => effect.label).filter(Boolean);
  const parts = [`${team?.name ?? 'The club'} — ${input.option.label}.`];
  if (input.option.cost > 0) parts.push(`${money(input.option.cost)} paid.`);
  // A branch with nothing lasting to show for itself still has its own words for what happened.
  if (consequences.length > 0) parts.push(`${consequences.join(' · ')}.`);
  else if (input.option.cost === 0) parts.push(input.option.detail);

  await tx.leagueEvent.create({
    data: {
      leagueId: input.event.leagueId,
      teamId: input.teamId,
      round: input.round,
      templateKey: `outcome:${input.event.templateKey}`,
      title: input.event.title,
      description: parts.join(' '),
      detail: JSON.stringify({
        eventId: input.event.id,
        choiceKey: input.option.key,
        // Keeps the gold on the outcome of a windfall, so the feed reads as one story.
        ...(tone ? { tone } : {}),
      }),
      status: 'NOTICE',
    },
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
        status: 'RESOLVED',
        choiceKey: option.key,
        resolvedAt: new Date(),
        resolvedById: input.actorUserId,
      },
    });

    await announceOutcome(tx, {
      event,
      teamId: input.teamId,
      round: league.round,
      option,
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
