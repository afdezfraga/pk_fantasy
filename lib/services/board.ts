/**
 * The event board: the untriggered deck, auctioned.
 *
 * Every `eventBoardHours` a board goes up with `eventBoardSize` events on it. Every club sees
 * the same events, each written against its own squad — the same injury lands on a different
 * Pokémon at every club — and each may place one sealed bid on each: what it would take to be
 * paid to live with it. When the board closes the lowest bid takes the event and the money, a
 * tie going to the club lower down the table, and the next board goes up.
 *
 * It turns events from something that happens to a club into something a club prices. A
 * manager with a deep bench can afford to be paid to lose a starter for three matches; one with
 * six Pokémon cannot. That is a judgement about your own squad, which is the game.
 *
 * Three rules hold it up:
 *
 * 1. **A bid is final.** One per club per event, enforced by a unique index, never updated.
 * 2. **A club bids on what it read.** Each club's version is frozen as an `EventOffer` and dealt
 *    exactly as shown — unless a Pokémon it names has left the club, in which case the same
 *    event is written again against the squad as it now stands, because an event about a
 *    Pokémon another club owns is not one anybody can serve.
 * 3. **Nothing happens outside a page load.** There is no scheduler. Whoever opens the league
 *    after the board closes settles it, with guarded updates so two of them cannot both.
 */

import type { Prisma } from '@prisma/client';

import { db } from '../db.ts';
import { money } from '../format.ts';
import { chargeForEvent } from './effects.ts';
import {
  dealEvent,
  isTriggered,
  materialise,
  parseChoices,
  pickWeighted,
  safeDeck,
  type EventTemplate,
  type Offer,
  type StoredOption,
} from './events.ts';
import { sortByLadder } from './ladder.ts';
import { audit } from './money.ts';
import { parseConfig } from './ownership.ts';
import { buildContext, requireReason, type EventContext } from './triggers.ts';

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardError';
  }
}

const HOUR = 60 * 60 * 1000;

// --- what can go up -----------------------------------------------------------------------------

/**
 * The option a club could take and walk away from untouched, if the template has one.
 *
 * Harmless on an event somebody is dealt — declining an opportunity is a real answer. On the
 * board it is free money: ask for the ceiling, win, decline. So a template carrying one stays
 * off the board until its free branch is given a price.
 */
export function freeBranch(template: EventTemplate): string | null {
  if (template.announcement) return null;
  const free = template.options.find((option) => !option.cost && option.effects.length === 0);
  return free?.key ?? null;
}

/** Every template the board may put up: the ones nobody causes, and nobody can take for free. */
export function boardDeck(deck: EventTemplate[]): EventTemplate[] {
  return deck.filter((template) => !isTriggered(template) && freeBranch(template) === null);
}

// --- one club's version -------------------------------------------------------------------------

interface StoredOffer {
  description: string;
  detail: string;
  choices: string;
  closedReason: string | null;
}

/**
 * The club's own Pokémon an offer names.
 *
 * The subject, and every Pokémon any branch would act on — a branch can reach past the subject,
 * to the other half of a falling-out or the starters a ripple lands on. Incoming free agents are
 * not here: the market substitutes for those when the event is answered.
 */
export function namedPokemon(offer: { detail: string; choices: string }): string[] {
  const detail = JSON.parse(offer.detail || '{}') as { subject?: string | null };
  const named = new Set<string>();
  if (detail.subject) named.add(detail.subject);
  for (const option of parseChoices(offer.choices)) {
    for (const effect of option.effects) if (effect.pokemonSlug) named.add(effect.pokemonSlug);
  }
  return [...named];
}

function isStale(offer: { detail: string; choices: string }, context: EventContext): boolean {
  const squad = new Set(context.squad.map((member) => member.pokemonSlug));
  return namedPokemon(offer).some((slug) => !squad.has(slug));
}

function write(template: EventTemplate, context: EventContext, random: () => number): StoredOffer {
  const offer = materialise(template, context, null, random);
  return {
    description: offer.description,
    detail: JSON.stringify({
      subject: offer.subject,
      ...(template.announcement ? { announcement: true } : {}),
      ...(template.tone ? { tone: template.tone } : {}),
    }),
    choices: JSON.stringify(offer.options),
    closedReason: requireReason(context, template.requires),
  };
}

/** A stored offer as `dealEvent` wants it. */
function asOffer(stored: { description: string; detail: string; choices: string }): Offer {
  const detail = JSON.parse(stored.detail || '{}') as { subject?: string | null };
  return {
    description: stored.description,
    subject: detail.subject ?? null,
    options: parseChoices(stored.choices),
  };
}

/**
 * Brings one club's offers on the open board up to date, writing any it is missing.
 *
 * Run whenever the club looks at the board and before it bids, so what it bids on is always
 * what it would be dealt. Rewrites only what has gone stale: a club looking twice at an event
 * that has not changed sees the same event twice.
 */
export async function refreshOffers(
  leagueId: string,
  teamId: string,
  random = Math.random,
): Promise<void> {
  const open = await db.eventAuction.findMany({
    where: { leagueId, status: 'OPEN' },
    include: { offers: { where: { teamId } } },
  });
  if (open.length === 0) return;

  const context = await buildContext(leagueId, teamId);
  if (!context) return;
  const deck = safeDeck();

  for (const auction of open) {
    const template = deck.find((candidate) => candidate.key === auction.templateKey);
    const current = auction.offers[0];

    // A template since deleted from the deck keeps whatever was frozen, as a drawn event does.
    if (!template) continue;

    if (!current || isStale(current, context)) {
      const fresh = write(template, context, random);
      await db.eventOffer.upsert({
        where: { auctionId_teamId: { auctionId: auction.id, teamId } },
        create: { auctionId: auction.id, teamId, ...fresh },
        update: fresh,
      });
      continue;
    }

    // Who may bid can change without anything named changing — a losing run ends, a squad
    // shrinks — so the gate is read again every time rather than frozen with the text.
    const reason = requireReason(context, template.requires);
    if (reason !== current.closedReason) {
      await db.eventOffer.update({
        where: { auctionId_teamId: { auctionId: auction.id, teamId } },
        data: { closedReason: reason },
      });
    }
  }
}

// --- the clock ----------------------------------------------------------------------------------

/**
 * Settles a board that has closed and puts the next one up. Cheap when there is nothing to do.
 *
 * Called on every page that shows events, the way listings are swept: there is no scheduler in
 * a one-process app, and a board nobody has looked at since it closed has lost nothing by
 * waiting for somebody to.
 */
export async function sweepBoard(
  leagueId: string,
  options: { now?: Date; random?: () => number } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;

  const league = await db.league.findUnique({ where: { id: leagueId } });
  if (!league || league.status !== 'ACTIVE') return;
  if (!parseConfig(league.config).eventsEnabled) return;
  if (league.boardUntil && league.boardUntil > now) return;

  const due = await db.eventAuction.findMany({
    where: { leagueId, status: 'OPEN', closesAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  for (const auction of due) await settle(auction.id, now, random);

  await openBoard(leagueId, league.boardUntil, now, random);
}

/**
 * When the next board closes: on the same beat as the last one, however long nobody looked.
 *
 * Anchored on the previous close rather than on now, so a daily board closes at the same time
 * every day instead of drifting later by however late the first visitor turned up. A league
 * nobody opened for a week does not get a week of boards at once — it gets one, closing on the
 * next beat.
 */
export function nextClose(previous: Date | null, now: Date, hours: number): Date {
  const period = Math.max(1, hours) * HOUR;
  if (!previous || previous > now) return new Date(now.getTime() + period);
  const missed = Math.floor((now.getTime() - previous.getTime()) / period) + 1;
  return new Date(previous.getTime() + missed * period);
}

async function openBoard(
  leagueId: string,
  previous: Date | null,
  now: Date,
  random: () => number,
): Promise<void> {
  const league = await db.league.findUniqueOrThrow({
    where: { id: leagueId },
    include: { teams: { select: { id: true } } },
  });
  const config = parseConfig(league.config);
  const closesAt = nextClose(previous, now, config.eventBoardHours);

  const contexts: EventContext[] = [];
  for (const team of league.teams) {
    const context = await buildContext(leagueId, team.id);
    if (context) contexts.push(context);
  }

  const chosen = contexts.length > 0 ? await drawBoard(leagueId, contexts, config.eventBoardSize, random) : [];

  // Every club's version written before the transaction, which only has to store them.
  const offers = chosen.map((template) => ({
    template,
    versions: contexts.map((context) => ({ teamId: context.teamId, ...write(template, context, random) })),
  }));

  await db.$transaction(async (tx) => {
    // Guarded on the close this caller saw, like `openNextRound`: two page loads after the
    // same close both reach here, and only one of them may put a board up.
    const moved = await tx.league.updateMany({
      where: { id: leagueId, boardUntil: previous },
      data: { boardUntil: closesAt },
    });
    if (moved.count !== 1) return;

    for (const { template, versions } of offers) {
      await tx.eventAuction.create({
        data: {
          leagueId,
          templateKey: template.key,
          title: template.title,
          round: league.round,
          closesAt,
          offers: { create: versions },
        },
      });
    }

    await audit(tx, {
      leagueId,
      action: 'BOARD_OPENED',
      detail: { closesAt: closesAt.toISOString(), templates: chosen.map((template) => template.key) },
    });
  });
}

/**
 * Which templates go up: weighted, no two the same, none seen on a recent board, and each one
 * something at least one club could bid on.
 *
 * `cooldown` counts auctions here rather than a club's own events, since the board is the
 * league's and a template that was up yesterday is one everybody has just read.
 */
async function drawBoard(
  leagueId: string,
  contexts: EventContext[],
  size: number,
  random: () => number,
): Promise<EventTemplate[]> {
  const recent = (
    await db.eventAuction.findMany({
      where: { leagueId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { templateKey: true },
    })
  ).map((row) => row.templateKey);

  let pool = boardDeck(safeDeck())
    .filter((template) => {
      const seenAt = recent.indexOf(template.key);
      return seenAt === -1 || seenAt >= (template.cooldown ?? 0);
    })
    // An event nobody may bid on is an event nobody will see.
    .filter((template) => contexts.some((context) => requireReason(context, template.requires) === null));

  const chosen: EventTemplate[] = [];
  for (let i = 0; i < Math.max(0, Math.round(size)) && pool.length > 0; i += 1) {
    const pick = pickWeighted(pool, random);
    if (!pick) break;
    chosen.push(pick);
    pool = pool.filter((template) => template.key !== pick.key);
  }
  return chosen;
}

// --- settling -----------------------------------------------------------------------------------

/**
 * The winning bid: the lowest ask, and on a tie the club lower down the table.
 *
 * The tie-break leans towards the club that needs the money, which is also the one a pointed
 * event hurts least to hand — it has the least to lose.
 */
export function winningBid<T extends { teamId: string; amount: number; createdAt: Date }>(
  bids: T[],
  /** Team ids best first, as the league table shows them. */
  table: string[],
): T | null {
  const position = (teamId: string) => {
    const at = table.indexOf(teamId);
    return at === -1 ? table.length : at;
  };
  const ranked = [...bids].sort(
    (a, b) =>
      a.amount - b.amount ||
      position(b.teamId) - position(a.teamId) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return ranked[0] ?? null;
}

async function settle(auctionId: string, now: Date, random: () => number): Promise<void> {
  const auction = await db.eventAuction.findUniqueOrThrow({
    where: { id: auctionId },
    include: { bids: true, league: { include: { teams: true } } },
  });
  if (auction.status !== 'OPEN') return;

  const table = sortByLadder(auction.league.teams).map((team) => team.id);
  // A bid is a bare row, so it outlives a club that has since left the league. It cannot win.
  const winner = winningBid(
    auction.bids.filter((bid) => table.includes(bid.teamId)),
    table,
  );

  if (!winner) {
    await db.$transaction(async (tx) => {
      const claimed = await tx.eventAuction.updateMany({
        where: { id: auctionId, status: 'OPEN' },
        data: { status: 'UNCLAIMED', settledAt: now },
      });
      if (claimed.count !== 1) return;
      await notice(tx, auction, `Nobody bid on “${auction.title}”. It has gone, and nobody has to live with it.`);
    });
    return;
  }

  // Worked out before the transaction, which SQLite will not let reach back out for the
  // context. Bids cannot move once the board has closed, so the winner read here is the winner.
  const context = await buildContext(auction.leagueId, winner.teamId);
  if (!context) return;
  const stored = await db.eventOffer.findUnique({
    where: { auctionId_teamId: { auctionId, teamId: winner.teamId } },
  });
  const inDeck = safeDeck().find((candidate) => candidate.key === auction.templateKey);

  // Deleted from the deck since it went up: what the club read is frozen on its offer, and
  // that is what it is dealt — the same promise a drawn event makes. Otherwise the offer is
  // written again if a Pokémon it names has left, exactly as the board would have shown it.
  let offer: Offer | null = stored ? asOffer(stored) : null;
  if (inDeck && (!stored || isStale(stored, context))) {
    offer = materialise(inDeck, context, null, random);
  }
  if (!offer) return; // Nothing on file and nothing to write it from. Left open; harmless.

  const template: EventTemplate = inDeck ?? {
    key: auction.templateKey,
    title: auction.title,
    description: offer.description,
    weight: 1,
    announcement: Boolean(stored && JSON.parse(stored.detail || '{}').announcement),
    options: [],
  };

  const teamName = auction.league.teams.find((team) => team.id === winner.teamId)?.name ?? 'A club';
  const bids = auction.bids.length;

  await db.$transaction(async (tx) => {
    const claimed = await tx.eventAuction.updateMany({
      where: { id: auctionId, status: 'OPEN' },
      data: {
        status: 'AWARDED',
        winnerTeamId: winner.teamId,
        winningBid: winner.amount,
        settledAt: now,
      },
    });
    if (claimed.count !== 1) return;

    const { id: eventId } = await dealEvent(tx, {
      leagueId: auction.leagueId,
      teamId: winner.teamId,
      round: auction.league.round,
      template,
      context,
      triggerSubject: null,
      offer,
      random,
      detail: { auctionId, bid: winner.amount },
    });
    await tx.eventAuction.update({ where: { id: auctionId }, data: { eventId } });

    await chargeForEvent(tx, {
      leagueId: auction.leagueId,
      teamId: winner.teamId,
      amount: winner.amount,
      description: `Paid to take on “${auction.title}”`,
      eventId,
      round: auction.league.round,
    });

    await notice(
      tx,
      auction,
      `${teamName} took on “${auction.title}” for ${money(winner.amount)}` +
        (bids > 1 ? `, the lowest of ${bids} bids.` : ', the only bid.'),
    );

    await audit(tx, {
      leagueId: auction.leagueId,
      action: 'BOARD_AWARDED',
      detail: { auctionId, teamId: winner.teamId, amount: winner.amount, bids, eventId },
    });
  });
}

/** The result, in the league feed. Only the winning figure: the losing bids stay sealed. */
async function notice(
  tx: Prisma.TransactionClient,
  auction: { id: string; leagueId: string; templateKey: string; title: string; league: { round: number } },
  description: string,
): Promise<void> {
  await tx.leagueEvent.create({
    data: {
      leagueId: auction.leagueId,
      teamId: null,
      round: auction.league.round,
      templateKey: `board:${auction.templateKey}`,
      title: 'Event board',
      description,
      detail: JSON.stringify({ auctionId: auction.id }),
      status: 'NOTICE',
    },
  });
}

// --- bidding ------------------------------------------------------------------------------------

/**
 * Places a club's sealed bid: what it asks to be paid to take the event on.
 *
 * The offer is brought up to date first, so a club never bids on a version of the event about a
 * Pokémon it has since sold.
 */
export async function placeBid(input: {
  leagueId: string;
  auctionId: string;
  teamId: string;
  amount: number;
  actorUserId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const league = await db.league.findUniqueOrThrow({ where: { id: input.leagueId } });
  const config = parseConfig(league.config);

  if (!Number.isInteger(input.amount) || input.amount < 0) {
    throw new BoardError('A bid is a whole number of Pokédollars, and cannot be negative.');
  }
  if (input.amount > config.eventBidMax) {
    throw new BoardError(`The most anybody may ask is ${money(config.eventBidMax)}.`);
  }

  const auction = await db.eventAuction.findUnique({ where: { id: input.auctionId } });
  if (!auction || auction.leagueId !== input.leagueId) throw new BoardError('That event is not on the board.');
  if (auction.status !== 'OPEN' || auction.closesAt <= now) {
    throw new BoardError('Bidding on that event has closed.');
  }

  await refreshOffers(input.leagueId, input.teamId);
  const offer = await db.eventOffer.findUnique({
    where: { auctionId_teamId: { auctionId: auction.id, teamId: input.teamId } },
  });
  if (!offer) throw new BoardError('That event is not on offer to your club.');
  if (offer.closedReason) throw new BoardError(offer.closedReason);

  const final = 'Your club has already bid on this. Bids are final.';
  const existing = await db.eventBid.findUnique({
    where: { auctionId_teamId: { auctionId: auction.id, teamId: input.teamId } },
  });
  if (existing) throw new BoardError(final);

  // The check above is for the message; the unique index is the rule, and catches the double
  // click that lands between the two.
  try {
    return await db.$transaction(async (tx) => {
      const bid = await tx.eventBid.create({
        data: { auctionId: auction.id, teamId: input.teamId, amount: input.amount },
      });
      await audit(tx, {
        leagueId: input.leagueId,
        actorUserId: input.actorUserId ?? null,
        action: 'BOARD_BID',
        detail: { auctionId: auction.id, teamId: input.teamId, amount: input.amount },
      });
      return bid;
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new BoardError(final);
    }
    throw error;
  }
}

// --- reading ------------------------------------------------------------------------------------

export interface BoardEntry {
  id: string;
  title: string;
  closesAt: Date;
  description: string;
  options: StoredOption[];
  announcement: boolean;
  closedReason: string | null;
  /** This club's own bid, if it has placed one. Nobody else's is ever shown. */
  myBid: number | null;
}

/** The open board as one club sees it: its own version of each event, and its own bids only. */
export async function getBoard(leagueId: string, teamId: string | null): Promise<BoardEntry[]> {
  if (teamId) await refreshOffers(leagueId, teamId);

  const auctions = await db.eventAuction.findMany({
    where: { leagueId, status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    include: {
      offers: teamId ? { where: { teamId } } : false,
      bids: teamId ? { where: { teamId } } : false,
    },
  });

  return auctions.map((auction) => {
    const offer = auction.offers?.[0];
    const detail = JSON.parse(offer?.detail || '{}') as { announcement?: boolean };
    return {
      id: auction.id,
      title: auction.title,
      closesAt: auction.closesAt,
      description: offer?.description ?? '',
      options: offer ? parseChoices(offer.choices) : [],
      announcement: Boolean(detail.announcement),
      closedReason: offer ? offer.closedReason : 'Your club has no squad for this to land on.',
      myBid: auction.bids?.[0]?.amount ?? null,
    };
  });
}

/** Boards already settled, newest first, as the league saw them announced. */
export async function recentResults(leagueId: string, take = 6) {
  const rows = await db.eventAuction.findMany({
    where: { leagueId, status: { in: ['AWARDED', 'UNCLAIMED'] } },
    orderBy: { settledAt: 'desc' },
    take,
    include: { _count: { select: { bids: true } } },
  });
  const teams = await db.team.findMany({ where: { leagueId }, select: { id: true, name: true } });
  const names = new Map(teams.map((team) => [team.id, team.name]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    settledAt: row.settledAt,
    winner: row.winnerTeamId ? (names.get(row.winnerTeamId) ?? 'A club') : null,
    winnerTeamId: row.winnerTeamId,
    amount: row.winningBid,
    bids: row._count.bids,
  }));
}
