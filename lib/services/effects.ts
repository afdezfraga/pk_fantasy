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
import { money, parseTypes, pokemonLabel } from '../format.ts';
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
  /**
   * Named Pokémon must take the field in every match, or the report is refused.
   *
   * Not "must open": the only thing a result records is whether a Pokémon was benched — brought
   * and never sent out — so taking the field is what the app can actually police. Opening the
   * match is `MUST_LEAD`, which has to be asked rather than checked.
   */
  MUST_FIELD: { attested: false, scope: 'pokemon' },
  /** No Pokémon of this type may be fielded. */
  TYPE_BAN: { attested: false, scope: 'team' },
  /**
   * The registered lineup may hold only `count`, instead of `lineupSize`.
   *
   * It does not touch how many go into a match: Champions is four out of a registered six, and
   * an event that changed that would be changing the game rather than the club. What it takes
   * away is the sixth name on the sheet, and with it the cover the manager was rotating through.
   */
  LINEUP_LIMIT: { attested: false, scope: 'team' },
  /** No buying, selling or trading while in force. */
  TRANSFER_FREEZE: { attested: false, scope: 'team' },
  /** One Pokémon leaves, one named free agent arrives. No money changes hands. */
  SWAP_OFFER: { attested: false, scope: 'pokemon', instant: true },
  /** One Pokémon leaves, two cheaper free agents arrive. Depth in exchange for quality. */
  RELEASE_FOR_TWO: { attested: false, scope: 'pokemon', instant: true },
  /** One Pokémon is sold back to the market at the price the offer named. */
  SELL_TO_MARKET: { attested: false, scope: 'pokemon', instant: true },
  /** The named Pokémon goes on the public board at a price, for any club to take. */
  LIST_FOR_SALE: { attested: false, scope: 'pokemon', instant: true },
  /**
   * One roll on a published table of absences, taken the moment the club accepts the gamble.
   *
   * The odds are printed on the button before it is pressed — Blood Bowl's casualty table, which
   * works because you knew what you were risking. Rolled at resolve rather than at draw for the
   * same reason the prize in `GIFT_POKEMON` is: a gamble whose answer already exists somewhere
   * in the database is not a gamble.
   */
  INJURY_ROLL: { attested: false, scope: 'pokemon', instant: true },
  /**
   * A free agent from one of the named tiers arrives for nothing, drawn when the club says yes.
   *
   * Which one is deliberately not settled at draw time, unlike everything else in the deck: the
   * offer is a tier, not a name, and the gamble is the point. A club that wanted certainty had
   * the money on the other button.
   */
  GIFT_POKEMON: { attested: false, scope: 'team', instant: true },

  // Money and value — enforced, applied once unless noted.
  /** A share of the club's balance, with a floor so a broke club still feels it. */
  CASH_PCT: { attested: false, scope: 'team', instant: true },
  /** A flat amount. Only where a percentage makes no sense. */
  CASH: { attested: false, scope: 'team', instant: true },
  /**
   * Charged per match while in force — the payment plan.
   *
   * With `onLoss` it is charged only on the matches the club loses, which turns an instalment
   * into something a manager can play their way out of.
   */
  UPKEEP: { attested: false, scope: 'team' },
  /** One Pokémon's value moves once. */
  VALUE_MOVE: { attested: false, scope: 'pokemon', instant: true },
  /** Every Pokémon of a type moves once. */
  TYPE_VALUE_SHIFT: { attested: false, scope: 'team', instant: true },
  /** Every Pokémon in the squad moves once — what a dressing room costs when it turns. */
  SQUAD_VALUE_SHIFT: { attested: false, scope: 'team', instant: true },
  /** Win rewards multiplied while in force. */
  PAYOUT_MULT: { attested: false, scope: 'team' },
  /** Value moves damped or amplified while in force. */
  VALUE_MULT: { attested: false, scope: 'team' },
  /** The club's captain cannot step into another event for a while. */
  CAPTAIN_SPENT: { attested: false, scope: 'team' },
  /** Money locked away now and returned, with interest, when the round comes round. */
  ESCROW: { attested: false, scope: 'team' },
  /** A wager on results: win `wins` of the next `outOf` for `reward`, or pay `penalty`. */
  PLEDGE: { attested: false, scope: 'team' },

  // The battle rules — attested. These are the ones that change how you actually play.
  NO_MEGA: { attested: true, scope: 'either' },
  NO_WEATHER: { attested: true, scope: 'team' },
  NO_TERRAIN: { attested: true, scope: 'team' },
  NO_STATUS_MOVES: { attested: true, scope: 'either' },
  /** Every *attacking* move must be same-type. Status moves are unaffected, whatever their type. */
  STAB_ONLY: { attested: true, scope: 'either' },
  /** No *attacking* move may be same-type. Status moves are unaffected, whatever their type. */
  NO_STAB: { attested: true, scope: 'either' },
  /** No switching by hand. A switch a move causes — Volt Switch, Parting Shot, Roar — is fine. */
  NO_SWITCHING: { attested: true, scope: 'team' },
  ZERO_EVS: { attested: true, scope: 'pokemon' },
  NO_ITEM: { attested: true, scope: 'pokemon' },
  FIXED_ITEM: { attested: true, scope: 'pokemon' },
  MUST_LEAD: { attested: true, scope: 'pokemon' },
  NO_PROTECT: { attested: true, scope: 'team' },
  /** Nothing that moves first, including priority a field condition grants. */
  NO_PRIORITY: { attested: true, scope: 'either' },
} as const;

export type EffectKind = keyof typeof EFFECT_KINDS;

/**
 * Pairs of effects that cannot both be honoured, in either order.
 *
 * Two restrictions that contradict each other do not make a club's life twice as hard — they
 * make reporting impossible, and since every one of these counts down only when a match is
 * reported, nothing ever lifts. "Garchomp is out injured" and "Garchomp must play" is a club
 * that can never log another game. So the newer one wins and the older is torn up: the most
 * recent thing to happen to a squad is the thing that is true about it.
 */
const CONTRADICTIONS: [EffectKind, EffectKind][] = [
  // Out injured, suspended or rested, against a promise that it plays.
  ['POKEMON_OUT', 'MUST_FIELD'],
  ['POKEMON_OUT', 'MUST_LEAD'],
  // Attack only with STAB, against attack with anything but.
  ['STAB_ONLY', 'NO_STAB'],
  // No held item, against holding a named one.
  ['NO_ITEM', 'FIXED_ITEM'],
];

/** Whether two effects could ever be honoured at the same time. */
export function contradicts(a: EffectKind, b: EffectKind): boolean {
  return CONTRADICTIONS.some(
    ([one, other]) => (a === one && b === other) || (a === other && b === one),
  );
}

/** Whether an effect is about one Pokémon, the whole club, or either. */
export function effectScope(kind: EffectKind): 'pokemon' | 'team' | 'either' {
  return EFFECT_KINDS[kind].scope;
}

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
  /** A wager's headline, kept so its label can be rewritten as the tally moves. */
  note?: string;
  /** The Pokémon coming the other way in a swap, pinned at draw time. */
  slug?: string;
  /** The Pokémon arriving in a release-for-two, pinned at draw time. */
  slugs?: string[];
  /** Market tiers a gifted Pokémon may come from, best first. */
  tiers?: string[];
  /** The faces of an injury table: how many matches out, one entry per equally likely outcome. */
  faces?: number[];
  /** An instalment that only falls due on a defeat. */
  onLoss?: boolean;
  /** What the arrival in a swap gains over the Pokémon that left, as a percentage of its value. */
  bonusPct?: number;
  // A wager, and its running tally.
  wins?: number;
  outOf?: number;
  won?: number;
  reward?: number;
  penalty?: number;
}

/** An effect in force, with its JSON parameters already parsed. */
export interface LiveEffect {
  id: string;
  kind: EffectKind;
  pokemonSlug: string | null;
  params: EffectParams;
  matchesLeft: number;
  /** Events this club must be dealt before it lifts, for favours measured in crises. */
  eventsLeft: number;
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
  eventsLeft: number;
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
    eventsLeft: row.eventsLeft,
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
    // Effects installed by the same decision share a timestamp to the millisecond, so `id`
    // breaks the tie and the strip doesn't reshuffle itself between page loads.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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

/** How many Pokémon may be registered as starters, once any `LINEUP_LIMIT` is applied. */
export function lineupCap(effects: LiveEffect[], configured: number): number {
  const limits = effects
    .filter((effect) => effect.kind === 'LINEUP_LIMIT')
    .map((effect) => effect.params.count ?? configured);
  return Math.max(1, Math.min(configured, ...limits));
}

/**
 * Whether this is something the club signed up to rather than something done to it.
 *
 * A sponsor target and a league bond sit in the same table as an injury and count down the same
 * way, but showing them in the same red "in force" box would tell a manager their own wager is a
 * punishment. They are shown apart, and they are the only two of their kind.
 */
export function isCommitment(kind: EffectKind): boolean {
  return kind === 'PLEDGE' || kind === 'ESCROW';
}

export function transfersFrozen(effects: LiveEffect[]): boolean {
  return effects.some((effect) => effect.kind === 'TRANSFER_FREEZE');
}

/**
 * Refuses a transfer while an event has the club's business frozen.
 *
 * Checked on the ownership paths a manager drives — signings, sales and trades — rather than on
 * the draft or the commissioner's tools, which are not the club dealing.
 */
export async function assertTransfersOpen(
  client: Prisma.TransactionClient | typeof db,
  leagueId: string,
  teamId: string,
): Promise<void> {
  const freeze = (await activeEffects(leagueId, teamId, client)).find(
    (effect) => effect.kind === 'TRANSFER_FREEZE',
  );
  if (freeze) throw new EffectViolation(`${freeze.label} — you cannot deal until it lifts.`);
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
  lineupSize: number;
}): EnforcementResult {
  const { effects, squad, lines, attested } = input;
  const played = lines.filter((line) => !line.benched);
  const { reasons, usable } = banned(effects, squad);

  // A shortened lineup is checked against who is registered, not against who played: the
  // manager still picks four, out of a sheet with one fewer name on it. Refusing here rather
  // than trimming the lineup behind their back keeps the choice of who drops out theirs.
  const cap = lineupCap(effects, input.lineupSize);
  const registered = squad.filter((member) => member.starter).length;
  if (registered > cap) {
    const effect = effects.find((candidate) => candidate.kind === 'LINEUP_LIMIT');
    throw new EffectViolation(
      `${effect?.label ?? 'A restriction'} — only ${cap} of your squad can be registered. Drop one to the bench on the Club page.`,
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
    // A Pokémon that may not play is excused from a promise that it will. `addEffect` tears up
    // the pair that would cause this, but a type ban bars a Pokémon it never names, and rows
    // written before that rule existed are still out there. Either way the club must be able to
    // report: a restriction that contradicts another one may not cost somebody their season.
    if (reasons.has(effect.pokemonSlug)) continue;
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
  /** Counted down when the club is dealt its next event, rather than when it plays. */
  events?: number;
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
  await supersede(tx, input);

  await tx.activeEffect.create({
    data: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: input.pokemonSlug ?? null,
      kind: input.kind,
      params: JSON.stringify(input.params ?? {}),
      matchesLeft: input.matches ?? 0,
      eventsLeft: input.events ?? 0,
      round: input.round ?? 1,
      untilRound: input.untilRound ?? null,
      attested: isAttested(input.kind),
      label: input.label,
      liftedMessage: input.liftedMessage,
      sourceEventId: input.sourceEventId ?? null,
    },
  });
}

/**
 * Tears up whatever the new effect contradicts, and says so.
 *
 * Scope is deliberately generous: a club-wide "no STAB attacking moves" contradicts a promise
 * made about one Pokémon, so a null slug on either side counts as a collision. Erring towards
 * clearing is safe — the worst case is a restriction ending early — while erring the other way
 * is a club that cannot report a match.
 */
async function supersede(
  tx: Prisma.TransactionClient,
  input: EffectSpec & { leagueId: string; teamId: string },
): Promise<void> {
  const rows = await tx.activeEffect.findMany({
    where: { leagueId: input.leagueId, teamId: input.teamId },
  });

  const torn = rows
    .map(toLive)
    .filter((effect): effect is LiveEffect => effect !== null)
    .filter((effect) => contradicts(effect.kind, input.kind))
    .filter(
      (effect) =>
        effect.pokemonSlug === null ||
        input.pokemonSlug == null ||
        effect.pokemonSlug === input.pokemonSlug,
    );
  if (torn.length === 0) return;

  await tx.activeEffect.deleteMany({ where: { id: { in: torn.map((effect) => effect.id) } } });

  for (const effect of torn) {
    await tx.leagueEvent.create({
      data: {
        leagueId: input.leagueId,
        teamId: input.teamId,
        round: input.round ?? 1,
        templateKey: `lifted:${effect.kind.toLowerCase()}`,
        title: 'Overtaken',
        description: `${effect.label} no longer applies. ${input.label}`,
        detail: JSON.stringify({ kind: effect.kind, pokemonSlug: effect.pokemonSlug, superseded: true }),
        status: 'NOTICE',
      },
    });
  }
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
/**
 * Puts one Pokémon's value at an absolute number rather than moving it by a percentage.
 *
 * A swap needs this: the arrival's stored value is a shop price, and what it should be worth to
 * this club is a margin over the Pokémon that left. Multiplying the number it came in with would
 * just carry the shop's scale across.
 */
export async function setValue(
  tx: Prisma.TransactionClient,
  input: {
    leagueId: string;
    teamId: string;
    pokemonSlug: string;
    to: number;
    /** Left out, the move records the percentage it actually was. */
    pct?: number;
    round: number;
  },
): Promise<void> {
  const row = await tx.ownership.findUnique({
    where: { leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug } },
  });
  if (!row || row.teamId !== input.teamId || row.marketValue === input.to) return;

  const moved = row.marketValue
    ? Math.round(((input.to - row.marketValue) / row.marketValue) * 100)
    : 0;

  await recordValue(tx, {
    ownershipId: row.id,
    leagueId: input.leagueId,
    teamId: input.teamId,
    pokemonSlug: input.pokemonSlug,
    reason: 'EVENT',
    from: row.marketValue,
    to: input.to,
    pct: input.pct ?? moved,
    round: input.round,
  });
}

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

/** Every Pokémon a club owns moves, which is what a squad-wide loss of faith looks like. */
export async function moveSquadValue(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; pct: number; round: number },
): Promise<number> {
  const rows = await tx.ownership.findMany({
    where: { leagueId: input.leagueId, teamId: input.teamId },
    select: { pokemonSlug: true },
  });

  let moved = 0;
  for (const row of rows) {
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
    // A pledge counts its own window down in `settlePledges`, because it has to know whether the
    // match was won before it can decide whether the wager is over.
    where: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      matchesLeft: { gt: 0 },
      kind: { not: 'PLEDGE' },
    },
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

/**
 * Counts down everything measured in events, and announces what that lifts.
 *
 * Called when a club is dealt its next event, so "your captain cannot step in again for five
 * events" is five crises rather than five games — a favour in the dressing room is spent on
 * trouble, and a club that plays ten quiet matches has not repaid it.
 */
export async function tickEventEffects(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; round: number },
): Promise<LiveEffect[]> {
  const rows = await tx.activeEffect.findMany({
    where: { leagueId: input.leagueId, teamId: input.teamId, eventsLeft: { gt: 0 } },
  });

  const lifted: LiveEffect[] = [];
  for (const row of rows) {
    const live = toLive(row);
    if (row.eventsLeft > 1) {
      await tx.activeEffect.update({
        where: { id: row.id },
        data: { eventsLeft: row.eventsLeft - 1 },
      });
      continue;
    }
    await tx.activeEffect.delete({ where: { id: row.id } });
    if (live) lifted.push(live);
  }

  await announceLifted(tx, { ...input, lifted });
  return lifted;
}

/**
 * Settles every wager this club has running, given how the match it just reported went.
 *
 * A pledge is the one effect whose end is not a countdown: it is over the moment the answer is
 * known. Hitting the target with matches to spare pays out there and then, and a target that can
 * no longer be reached is finished whether or not its window is — being told at the fifth match
 * that you failed at the third is a worse experience than being told at the third.
 *
 * Until then the label is rewritten each match, so the strip on the squad board reads "1 of 2
 * wins" rather than a number the manager has to keep in their own head.
 */
export async function settlePledges(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; round: number; won: boolean },
): Promise<void> {
  const rows = await tx.activeEffect.findMany({
    where: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      kind: 'PLEDGE',
      matchesLeft: { gt: 0 },
    },
  });

  for (const row of rows) {
    const params = parseParams(row.params);
    const target = params.wins ?? 0;
    const tally = (params.won ?? 0) + (input.won ? 1 : 0);
    const left = row.matchesLeft - 1;
    const headline = params.note ?? row.label;

    const met = tally >= target;
    if (!met && tally + left >= target) {
      await tx.activeEffect.update({
        where: { id: row.id },
        data: {
          matchesLeft: left,
          params: JSON.stringify({ ...params, won: tally, note: headline }),
          label: `${headline} — ${tally} of ${target} wins`,
        },
      });
      continue;
    }

    const amount = met ? (params.reward ?? 0) : -(params.penalty ?? 0);
    if (amount !== 0) {
      await postEntry(
        tx,
        {
          leagueId: input.leagueId,
          teamId: input.teamId,
          type: 'EVENT',
          amount,
          description: met ? `${headline} — target met` : `${headline} — target missed`,
          relatedId: row.sourceEventId ?? undefined,
          round: input.round,
        },
        // A club that backed itself and lost still has to be able to report its next match.
        { allowNegative: true },
      );
    }

    await tx.activeEffect.delete({ where: { id: row.id } });

    const outcome = met
      ? `${headline}: ${tally} of ${params.outOf ?? target} won. ${money(params.reward ?? 0)} paid.`
      : `${headline}: ${tally} of ${target} wins. ${money(params.penalty ?? 0)} forfeited.`;
    await tx.leagueEvent.create({
      data: {
        leagueId: input.leagueId,
        teamId: input.teamId,
        round: input.round,
        templateKey: 'lifted:pledge',
        title: met ? 'Target met' : 'Target missed',
        description: `${outcome} ${row.liftedMessage}`.trim(),
        detail: JSON.stringify({ kind: 'PLEDGE', met, wins: tally, target }),
        status: 'NOTICE',
      },
    });
  }
}

/**
 * Takes a win back off every running wager, for a result that has been deleted.
 *
 * The generic restore in `deleteMatch` hands the match back to every countdown, which for a
 * wager would return the match without returning the win and quietly make the target easier.
 * A wager that has already settled is gone from this table and stays settled, the same way a
 * decision already taken does.
 */
export async function restorePledges(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; teamId: string; won: boolean },
): Promise<void> {
  if (!input.won) return;

  const rows = await tx.activeEffect.findMany({
    where: { leagueId: input.leagueId, teamId: input.teamId, kind: 'PLEDGE' },
  });

  for (const row of rows) {
    const params = parseParams(row.params);
    const tally = Math.max(0, (params.won ?? 0) - 1);
    const headline = params.note ?? row.label;
    await tx.activeEffect.update({
      where: { id: row.id },
      data: {
        params: JSON.stringify({ ...params, won: tally }),
        label: `${headline} — ${tally} of ${params.wins ?? 0} wins`,
      },
    });
  }
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

  // Locked money comes back before the row that locked it goes away.
  for (const row of rows) {
    const live = toLive(row);
    if (live?.kind !== 'ESCROW') continue;
    const returned = Math.round(((live.params.amount ?? 0) * (live.params.returnPct ?? 100)) / 100);
    if (returned > 0) {
      await postEntry(tx, {
        leagueId: input.leagueId,
        teamId: row.teamId,
        type: 'EVENT',
        amount: returned,
        description: `${live.label} — returned`,
        relatedId: row.sourceEventId ?? undefined,
        round: input.round,
      });
    }
  }

  await tx.activeEffect.deleteMany({
    where: { leagueId: input.leagueId, untilRound: { not: null, lte: input.round } },
  });

  for (const [teamId, lifted] of byTeam) {
    await announceLifted(tx, { leagueId: input.leagueId, teamId, round: input.round, lifted });
  }
}

/**
 * Tears up everything in force, for a season that has ended.
 *
 * A restriction outlives the thing it was about. `advanceSeason` sells every Pokémon but the
 * captain and puts every club back to the bottom rung, so a `MUST_FIELD` on a Pokémon another
 * club now owns would block match reports forever, a lineup limit would apply to a squad that
 * no longer exists, and a five-match wager set in October would settle against a side drafted
 * in March. None of them describe the new season, so none of them survive it.
 *
 * Money that a club put in is money a club gets back. Locked stakes return at face value and
 * wagers are torn up as a push — no reward, no penalty — because the club never got the matches
 * it was promised, and charging it for a target the league itself made unreachable would be
 * the league keeping the stake.
 */
export async function clearEffectsForSeason(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; round: number },
): Promise<{ cleared: number; refunded: number }> {
  const rows = await tx.activeEffect.findMany({ where: { leagueId: input.leagueId } });
  let refunded = 0;

  for (const row of rows) {
    const live = toLive(row);
    if (!live) continue;

    // A stake comes back as it went in. The interest was for seeing the term out.
    const stake = live.kind === 'ESCROW' ? (live.params.amount ?? 0) : 0;
    if (stake > 0) {
      refunded += stake;
      await postEntry(tx, {
        leagueId: input.leagueId,
        teamId: row.teamId,
        type: 'EVENT',
        amount: stake,
        description: `${live.label} — returned, season over`,
        relatedId: row.sourceEventId ?? undefined,
        round: input.round,
      });
    }

    if (live.kind === 'ESCROW' || live.kind === 'PLEDGE') {
      await tx.leagueEvent.create({
        data: {
          leagueId: input.leagueId,
          teamId: row.teamId,
          round: input.round,
          templateKey: `lifted:${live.kind.toLowerCase()}`,
          title: live.kind === 'PLEDGE' ? 'Target called off' : 'Stake returned',
          description:
            live.kind === 'PLEDGE'
              ? `${live.label}: the season ended before the matches did. Nothing paid, nothing forfeited.`
              : `${live.label}: returned in full when the season closed.`,
          detail: JSON.stringify({ kind: live.kind, seasonEnd: true }),
          status: 'NOTICE',
        },
      });
    }
  }

  const { count } = await tx.activeEffect.deleteMany({ where: { leagueId: input.leagueId } });
  return { cleared: count, refunded };
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
    // Only restrictions ending. The feed carries other notices — what a club chose, chiefly —
    // and telling somebody about the decision they just took is noise, not news.
    where: { leagueId, teamId, status: 'NOTICE', templateKey: { startsWith: 'lifted:' } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/** Label for a Pokémon in an effect's text, so the deck can write "{pokemon} is out injured". */
export function effectSubject(pokemon: { name: string; form?: string | null } | null): string {
  return pokemon ? pokemonLabel(pokemon) : 'The squad';
}

export { VALUE_RULES };
