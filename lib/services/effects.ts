/**
 * What an event left behind, and how long it lasts.
 *
 * The app never simulates a battle — every result is typed in by hand — so an event's
 * consequences come in two kinds, and the difference runs through everything here:
 *
 * - **Enforced.** The app can refuse the action. "Charizard is out injured" is checked at report
 *   time exactly the way the starting-lineup rule already is.
 * - **Attested.** The app cannot check it. "No Mega Evolution for four matches" is a promise, so
 *   the report form asks the manager to tick a box and records what they said. That is the same
 *   honour system the scores themselves run on: anyone can report anything, and the feed shows
 *   who said what.
 *
 * Effects are counted down in *matches played*, not rounds, because matches are the clock every
 * manager actually feels — rounds close whenever the commissioner gets round to it.
 */

import type { Prisma } from '@prisma/client';

import { applyPct, VALUE_RULES } from '../../config/economy.ts';
import { db } from '../db.ts';
import { parseTypes, pokemonLabel } from '../format.ts';
import { postEntry } from './money.ts';
import { recordValue } from './value.ts';

// --- the vocabulary ---------------------------------------------------------------------------

/**
 * Every kind of consequence an event may leave. Closed on purpose: new *events* need no code,
 * but a new kind of consequence does, which keeps `data/events.json` from growing a scripting
 * language nobody can test.
 */
export const EFFECT_KINDS = {
  // Roster — enforced.
  /** Named Pokémon cannot be fielded. Injury, loan, suspension, a strike. */
  POKEMON_OUT: { attested: false, scope: 'pokemon' },
  /** Named Pokémon must appear in every match, or the report is refused. */
  MUST_FIELD: { attested: false, scope: 'pokemon' },
  /** No Pokémon of this type may be fielded. */
  TYPE_BAN: { attested: false, scope: 'team' },
  /** Bring fewer than `bringToMatch` to a match. */
  BRING_LIMIT: { attested: false, scope: 'team' },
  /** No buying, selling or trading while in force. */
  TRANSFER_FREEZE: { attested: false, scope: 'team' },

  // Money and value — enforced, applied once unless noted.
  /** A share of the club's balance, with a floor so a broke club still feels it. */
  CASH_PCT: { attested: false, scope: 'team', instant: true },
  /** A flat amount. Only where a percentage makes no sense. */
  CASH: { attested: false, scope: 'team', instant: true },
  /** Charged every match while in force — the payment plan. */
  UPKEEP: { attested: false, scope: 'team' },
  /** One Pokémon's value moves once. */
  VALUE_MOVE: { attested: false, scope: 'pokemon', instant: true },
  /** Every Pokémon of a type moves once. */
  TYPE_VALUE_SHIFT: { attested: false, scope: 'team', instant: true },
  /** Win rewards multiplied while in force. */
  PAYOUT_MULT: { attested: false, scope: 'team' },
  /** Value moves damped or amplified while in force. */
  VALUE_MULT: { attested: false, scope: 'team' },
  /** The club's captain cannot step into another event for a while. */
  CAPTAIN_SPENT: { attested: false, scope: 'team' },

  // The battle rules — attested. These are the ones that change how you actually play.
  NO_MEGA: { attested: true, scope: 'either' },
  NO_WEATHER: { attested: true, scope: 'team' },
  NO_TERRAIN: { attested: true, scope: 'team' },
  NO_STATUS_MOVES: { attested: true, scope: 'either' },
  STAB_ONLY: { attested: true, scope: 'either' },
  NO_STAB: { attested: true, scope: 'either' },
  NO_SWITCHING: { attested: true, scope: 'team' },
  ZERO_EVS: { attested: true, scope: 'pokemon' },
  NO_ITEM: { attested: true, scope: 'pokemon' },
  FIXED_ITEM: { attested: true, scope: 'pokemon' },
  MUST_LEAD: { attested: true, scope: 'pokemon' },
  NO_PROTECT: { attested: true, scope: 'team' },
} as const;

export type EffectKind = keyof typeof EFFECT_KINDS;

export function isEffectKind(value: string): value is EffectKind {
  return Object.hasOwn(EFFECT_KINDS, value);
}

/** Whether the app can check this itself, or has to ask. */
export function isAttested(kind: EffectKind): boolean {
  return EFFECT_KINDS[kind].attested;
}

/** Applied the moment an option is taken, rather than sitting in force for N matches. */
export function isInstant(kind: EffectKind): boolean {
  return 'instant' in EFFECT_KINDS[kind] && EFFECT_KINDS[kind].instant === true;
}

export interface EffectParams {
  pct?: number;
  min?: number;
  amount?: number;
  times?: number;
  count?: number;
  type?: string;
  item?: string;
  returnPct?: number;
}

/** An effect in force, with its JSON parameters already parsed. */
export interface LiveEffect {
  id: string;
  kind: EffectKind;
  pokemonSlug: string | null;
  params: EffectParams;
  matchesLeft: number;
  untilRound: number | null;
  attested: boolean;
  label: string;
  liftedMessage: string;
}

/**
 * One line of "what this match was played under", frozen onto the Match row.
 *
 * Stored rather than looked up later so a result always remembers its own conditions, and
 * editing the deck can never rewrite the history of a match already reported.
 */
export interface MatchConstraint {
  kind: EffectKind;
  label: string;
  attested: boolean;
  /** For attested constraints: whether the manager ticked the box. */
  honoured?: boolean;
}

export class EffectViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectViolation';
  }
}

// --- reading ------------------------------------------------------------------------------------

function parseParams(json: string): EffectParams {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toLive(row: {
  id: string;
  kind: string;
  pokemonSlug: string | null;
  params: string;
  matchesLeft: number;
  untilRound: number | null;
  attested: boolean;
  label: string;
  liftedMessage: string;
}): LiveEffect | null {
  if (!isEffectKind(row.kind)) return null;
  return {
    id: row.id,
    kind: row.kind,
    pokemonSlug: row.pokemonSlug,
    params: parseParams(row.params),
    matchesLeft: row.matchesLeft,
    untilRound: row.untilRound,
    attested: row.attested,
    label: row.label,
    liftedMessage: row.liftedMessage,
  };
}

/**
 * Everything in force for a club right now.
 *
 * An unknown `kind` is dropped rather than thrown on: a database written by a newer version of
 * the deck should degrade to "that restriction isn't enforced" rather than making the club
 * unable to report anything at all.
 */
export async function activeEffects(
  leagueId: string,
  teamId: string,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<LiveEffect[]> {
  const rows = await client.activeEffect.findMany({
    where: { leagueId, teamId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toLive).filter((effect): effect is LiveEffect => effect !== null);
}

/** The attested effects a manager has to tick before a report is accepted. */
export function attestationsRequired(effects: LiveEffect[]): LiveEffect[] {
  return effects.filter((effect) => effect.attested);
}

/** Win rewards are multiplied by every `PAYOUT_MULT` in force, compounding. */
export function payoutMultiplier(effects: LiveEffect[]): number {
  return effects
    .filter((effect) => effect.kind === 'PAYOUT_MULT')
    .reduce((product, effect) => product * (effect.params.times ?? 1), 1);
}

/** Value moves are scaled the same way. */
export function valueMultiplier(effects: LiveEffect[]): number {
  return effects
    .filter((effect) => effect.kind === 'VALUE_MULT')
    .reduce((product, effect) => product * (effect.params.times ?? 1), 1);
}

/** How many Pokémon may be taken into a match, once any `BRING_LIMIT` is applied. */
export function bringLimit(effects: LiveEffect[], configured: number): number {
  const limits = effects
    .filter((effect) => effect.kind === 'BRING_LIMIT')
    .map((effect) => effect.params.count ?? configured);
  return Math.max(1, Math.min(configured, ...limits));
}

export function transfersFrozen(effects: LiveEffect[]): boolean {
  return effects.some((effect) => effect.kind === 'TRANSFER_FREEZE');
}

/** True while the captain is still recovering from stepping into a previous event. */
export function captainSpent(effects: LiveEffect[]): boolean {
  return effects.some((effect) => effect.kind === 'CAPTAIN_SPENT');
}

// --- enforcement --------------------------------------------------------------------------------

export interface SquadMember {
  pokemonSlug: string;
  starter: boolean;
  types: string[];
}

export interface BanReason {
  pokemonSlug: string;
  label: string;
}

/**
 * Which of a club's starters an event currently bars, and whether that bar actually binds.
 *
 * A ban must never stop a club fielding a match at all — that would be a dead end with no way
 * out, since you cannot report your way back to a full squad. So a ban is only enforced while
 * enough usable starters remain to field one without it. Below that line it *degrades*: the
 * Pokémon may be taken, but only benched, and sending it out forfeits the match.
 */
export function banned(
  effects: LiveEffect[],
  squad: SquadMember[],
): { reasons: Map<string, string>; enforced: boolean; usable: number } {
  const reasons = new Map<string, string>();
  const starters = squad.filter((member) => member.starter);

  for (const effect of effects) {
    if (effect.kind === 'POKEMON_OUT' && effect.pokemonSlug) {
      reasons.set(effect.pokemonSlug, effect.label);
    }
    if (effect.kind === 'TYPE_BAN' && effect.params.type) {
      const type = effect.params.type;
      for (const member of starters) {
        if (member.types.includes(type)) reasons.set(member.pokemonSlug, effect.label);
      }
    }
  }

  const usable = starters.filter((member) => !reasons.has(member.pokemonSlug)).length;
  return { reasons, enforced: true, usable };
}

export interface ReportedLine {
  pokemonSlug: string;
  benched: boolean;
}

export interface EnforcementResult {
  /** Constraints to freeze onto the Match row. */
  constraints: MatchConstraint[];
  /**
   * True when a Pokémon that may not play was sent out anyway. The match is then recorded as a
   * loss — the surrender the rules call for — rather than refused, because refusing would leave
   * a club that has sold down below a legal squad unable to report at all.
   */
  surrendered: boolean;
  surrenderReason: string | null;
}

/**
 * Checks a reported match against everything in force, and says what to write on it.
 *
 * Throws `EffectViolation` for anything the manager can fix by changing the report — bringing a
 * Pokémon that is plainly available, missing an attestation, exceeding a bring limit. Returns a
 * surrender for the one case they cannot fix, which is having too few usable Pokémon to field a
 * legal four.
 */
export function enforce(input: {
  effects: LiveEffect[];
  squad: SquadMember[];
  lines: ReportedLine[];
  attested: string[];
  bringToMatch: number;
}): EnforcementResult {
  const { effects, squad, lines, attested } = input;
  const played = lines.filter((line) => !line.benched);
  const { reasons, usable } = banned(effects, squad);

  const limit = bringLimit(effects, input.bringToMatch);
  if (lines.length > limit) {
    const effect = effects.find((candidate) => candidate.kind === 'BRING_LIMIT');
    throw new EffectViolation(
      `${effect?.label ?? 'A restriction'} — you may only bring ${limit} to a match.`,
    );
  }

  // A banned Pokémon may only be brought at all when the club cannot otherwise field a match.
  // Above that line, bringing one is a mistake the manager can simply correct.
  const degraded = usable < input.bringToMatch;
  for (const line of lines) {
    const reason = reasons.get(line.pokemonSlug);
    if (!reason) continue;
    if (!degraded) {
      throw new EffectViolation(`${reason}. Pick someone else.`);
    }
  }

  let surrendered = false;
  let surrenderReason: string | null = null;
  for (const line of played) {
    const reason = reasons.get(line.pokemonSlug);
    if (reason) {
      surrendered = true;
      surrenderReason = reason;
      break;
    }
  }

  for (const effect of effects) {
    if (effect.kind !== 'MUST_FIELD' || !effect.pokemonSlug) continue;
    const brought = played.some((line) => line.pokemonSlug === effect.pokemonSlug);
    if (!brought) throw new EffectViolation(`${effect.label} — it has to play this match.`);
  }

  const required = attestationsRequired(effects);
  const ticked = new Set(attested);
  for (const effect of required) {
    if (!ticked.has(effect.id)) {
      throw new EffectViolation(`Confirm you played under: ${effect.label}`);
    }
  }

  const constraints: MatchConstraint[] = effects.map((effect) => ({
    kind: effect.kind,
    label: effect.label,
    attested: effect.attested,
    ...(effect.attested ? { honoured: ticked.has(effect.id) } : {}),
  }));

  return { constraints, surrendered, surrenderReason };
}

export function parseConstraints(json: string | null): MatchConstraint[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- writing ------------------------------------------------------------------------------------

export interface EffectSpec {
  kind: EffectKind;
  pokemonSlug?: string | null;
  params?: EffectParams;
  matches?: number;
  /** The round it comes into force. */
  round?: number;
  untilRound?: number | null;
  label: string;
  liftedMessage: string;
}

/**
 * Puts an effect in force.
 *
 * `attested` is taken from the vocabulary rather than the deck, so an event author cannot
 * accidentally declare a rule the app is expected to police but cannot see.
 */
export async function addEffect(
  tx: Prisma.TransactionClient,
  input: EffectSpec & { leagueId: string; teamId: string; sourceEventId?: string | null },
): Promise<void> {
  await tx.activeEffect.create({
    data: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: input.pokemonSlug ?? null,
      kind: input.kind,
      params: JSON.stringify(input.params ?? {}),
      matchesLeft: input.matches ?? 0,
      round: input.round ?? 1,
      untilRound: input.untilRound ?? null,
      attested: isAttested(input.kind),
      label: input.label,
      liftedMessage: input.liftedMessage,
      sourceEventId: input.sourceEventId ?? null,
    },
  });
}

/** What a percentage-of-cash charge actually costs, never less than its floor. */
export function cashCost(cash: number, params: EffectParams): number {
  const pct = params.pct ?? 0;
  const floor = params.min ?? 0;
  return Math.max(floor, Math.round((Math.max(0, cash) * pct) / 100));
}

/**
 * Charges a club for an event.
 *
 * Alone in the app, this may push a balance negative. `postEntry` documents the case exactly:
 * a charge a team cannot decline goes into debt rather than blocking, because the alternative
 * is a club that can never answer its event and so can never report another match. Debt is its
 * own punishment — `acquireFreeAgent` posts without `allowNegative`, so its guarded debit
 * refuses any signing while the balance is under water.
 */
export async function chargeForEvent(
  tx: Prisma.TransactionClient,
  input: {
    leagueId: string;
    teamId: string;
    amount: number;
    description: string;
    eventId?: string;
    round?: number;
  },
): Promise<void> {
  if (input.amount === 0) return;
  await postEntry(
    tx,
    {
      leagueId: input.leagueId,
      teamId: input.teamId,
      type: 'EVENT',
      amount: input.amount,
      description: input.description,
      relatedId: input.eventId,
      round: input.round,
    },
    { allowNegative: true },
  );
}

/** Moves one owned Pokémon's value, through `recordValue` so the trail explains the number. */
export async function moveValue(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; pokemonSlug: string; pct: number; round: number },
): Promise<number> {
  const row = await tx.ownership.findUnique({
    where: { leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug } },
  });
  if (!row || row.teamId !== input.teamId) return 0;

  const next = applyPct(row.marketValue, input.pct);
  if (next === row.marketValue) return 0;

  await recordValue(tx, {
    ownershipId: row.id,
    leagueId: input.leagueId,
    teamId: input.teamId,
    pokemonSlug: input.pokemonSlug,
    reason: 'EVENT',
    from: row.marketValue,
    to: next,
    pct: input.pct,
    round: input.round,
  });
  return next - row.marketValue;
}

/** Every Pokémon of a type moves, across one club. */
export async function moveTypeValue(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; type: string; pct: number; round: number },
): Promise<number> {
  const rows = await tx.ownership.findMany({
    where: { leagueId: input.leagueId, teamId: input.teamId },
    include: { pokemon: { select: { types: true } } },
  });

  let moved = 0;
  for (const row of rows) {
    if (!parseTypes(row.pokemon.types).includes(input.type)) continue;
    const delta = await moveValue(tx, {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: row.pokemonSlug,
      pct: input.pct,
      round: input.round,
    });
    if (delta !== 0) moved += 1;
  }
  return moved;
}

// --- expiry -------------------------------------------------------------------------------------

/**
 * Counts every match-based effect down one, and announces the ones that lift.
 *
 * A restriction that ends silently is one the manager never notices they had, so expiry writes
 * a `NOTICE` row into the same feed the events themselves use — no new plumbing, and the news
 * that Charizard's Mega is available again turns up next to the news that took it away.
 */
export async function tickEffects(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; round: number },
): Promise<LiveEffect[]> {
  const rows = await tx.activeEffect.findMany({
    where: { leagueId: input.leagueId, teamId: input.teamId, matchesLeft: { gt: 0 } },
  });

  const lifted: LiveEffect[] = [];
  for (const row of rows) {
    const live = toLive(row);
    if (row.matchesLeft > 1) {
      await tx.activeEffect.update({
        where: { id: row.id },
        data: { matchesLeft: row.matchesLeft - 1 },
      });
      continue;
    }
    await tx.activeEffect.delete({ where: { id: row.id } });
    if (live) lifted.push(live);
  }

  await announceLifted(tx, { ...input, lifted });
  return lifted;
}

/** The same, for effects measured in rounds rather than matches. Called when a round closes. */
export async function expireByRound(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; round: number },
): Promise<void> {
  const rows = await tx.activeEffect.findMany({
    where: { leagueId: input.leagueId, untilRound: { not: null, lte: input.round } },
  });

  const byTeam = new Map<string, LiveEffect[]>();
  for (const row of rows) {
    const live = toLive(row);
    if (!live) continue;
    byTeam.set(row.teamId, [...(byTeam.get(row.teamId) ?? []), live]);
  }

  await tx.activeEffect.deleteMany({
    where: { leagueId: input.leagueId, untilRound: { not: null, lte: input.round } },
  });

  for (const [teamId, lifted] of byTeam) {
    await announceLifted(tx, { leagueId: input.leagueId, teamId, round: input.round, lifted });
  }
}

async function announceLifted(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; round: number; lifted: LiveEffect[] },
): Promise<void> {
  for (const effect of input.lifted) {
    await tx.leagueEvent.create({
      data: {
        leagueId: input.leagueId,
        teamId: input.teamId,
        round: input.round,
        templateKey: `lifted:${effect.kind.toLowerCase()}`,
        title: 'Restriction lifted',
        description: effect.liftedMessage,
        detail: JSON.stringify({ kind: effect.kind, pokemonSlug: effect.pokemonSlug }),
        status: 'NOTICE',
      },
    });
  }
}

/** Notices a club has not seen yet, newest first — the "this just lifted" banner. */
export async function recentlyLifted(leagueId: string, teamId: string, take = 3) {
  return db.leagueEvent.findMany({
    where: { leagueId, teamId, status: 'NOTICE' },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/** Label for a Pokémon in an effect's text, so the deck can write "{pokemon} is out injured". */
export function effectSubject(pokemon: { name: string; form?: string | null } | null): string {
  return pokemon ? pokemonLabel(pokemon) : 'The squad';
}

export { VALUE_RULES };
