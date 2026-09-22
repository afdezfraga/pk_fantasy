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

import { roundTo } from '../../config/economy.ts';
import { db } from '../db.ts';
import { money, pokemonLabel } from '../format.ts';
import {
  addEffect,
  chargeForEvent,
  cashCost,
  isEffectKind,
  isInstant,
  moveTypeValue,
  moveValue,
  type EffectKind,
  type EffectParams,
} from './effects.ts';
import { audit } from './money.ts';
import { parseConfig } from './ownership.ts';
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
    if (!effect.matches && !effect.rounds) {
      problems.push(`${where}: effect ${effect.kind} needs a duration in matches or rounds`);
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
  const member = context.squad.find((candidate) => candidate.pokemonSlug === slug);
  return member ? pokemonLabel(member) : 'The squad';
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

  const options: StoredOption[] = template.options.map((option) => {
    const cost = costOf(context, option, subject);
    const available = meetsRequires(context, option.requires);
    const vars = { ...baseVars, cost: money(cost) };

    const effects: StoredEffect[] = option.effects.map((effect) => {
      const slug = effect.target
        ? resolveTarget(context, effect.target, triggerSubject, random)
        : subject;
      const type = resolveType(context, effect.type, random);
      const effectVars = { ...vars, pokemon: labelFor(context, slug), ...(type ? { type } : {}) };

      const params: EffectParams = {};
      if (effect.pct !== undefined) params.pct = effect.pct;
      if (effect.times !== undefined) params.times = effect.times;
      if (effect.count !== undefined) params.count = effect.count;
      if (effect.amount !== undefined) params.amount = effect.amount;
      if (effect.min !== undefined) params.min = effect.min;
      if (effect.item !== undefined) params.item = effect.item;
      if (type) params.type = type;

      return {
        kind: effect.kind as EffectKind,
        // Team-wide effects carry no slug even when the event is about one Pokémon.
        pokemonSlug: effect.kind === 'TYPE_BAN' || effect.kind === 'TYPE_VALUE_SHIFT' ? null : slug,
        params,
        matches: effect.matches ?? 0,
        rounds: effect.rounds ?? 0,
        label: render(effect.label ?? '', effectVars),
        liftedMessage: render(effect.liftedMessage ?? '', effectVars),
      };
    });

    return {
      key: option.key,
      label: option.label,
      detail: render(option.detail, vars),
      default: option.default === true,
      available,
      ...(available ? {} : { unavailableReason: 'Not available to your club right now.' }),
      cost,
      effects,
    };
  });

  return { description: render(template.description, baseVars), subject, options };
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

  await addEffect(tx, {
    leagueId: input.leagueId,
    teamId: input.teamId,
    pokemonSlug: effect.pokemonSlug,
    kind: effect.kind,
    params: effect.params,
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
