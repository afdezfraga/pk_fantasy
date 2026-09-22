/**
 * Player-to-player trades: Pokémon and cash in either direction, accepted by the other side.
 *
 * The swap itself reuses the same guarded-update discipline as every other ownership change —
 * each Pokémon moves only if the team we expect to own it still does.
 */

import { db } from '../db.ts';
import { assertTransfersOpen } from './effects.ts';
import { audit, postEntry } from './money.ts';
import { OwnershipConflict, RosterRuleViolation, parseConfig } from './ownership.ts';

export class TradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradeError';
  }
}

export async function proposeTrade(input: {
  leagueId: string;
  fromTeamId: string;
  toTeamId: string;
  /** Pokémon leaving the proposer. */
  givePokemon: string[];
  /** Pokémon leaving the recipient. */
  getPokemon: string[];
  /** Cash the proposer adds; negative asks for cash instead. */
  cash: number;
  note?: string;
  actorUserId: string;
}) {
  if (input.fromTeamId === input.toTeamId) throw new TradeError('You cannot trade with yourself.');
  // Both clubs have to be free to deal — an offer nobody could accept is worse than no offer.
  await assertTransfersOpen(db, input.leagueId, input.fromTeamId);
  await assertTransfersOpen(db, input.leagueId, input.toTeamId);
  if (input.givePokemon.length === 0 && input.getPokemon.length === 0 && input.cash === 0) {
    throw new TradeError('A trade needs at least one Pokémon or some cash.');
  }

  // Verify both sides actually own what they're offering, before anyone gets excited.
  const rows = await db.ownership.findMany({
    where: {
      leagueId: input.leagueId,
      pokemonSlug: { in: [...input.givePokemon, ...input.getPokemon] },
    },
    include: { pokemon: { select: { name: true } } },
  });
  const byslug = new Map(rows.map((row) => [row.pokemonSlug, row]));

  for (const slug of input.givePokemon) {
    if (byslug.get(slug)?.teamId !== input.fromTeamId) {
      throw new TradeError(`You no longer own ${byslug.get(slug)?.pokemon.name ?? slug}.`);
    }
  }
  for (const slug of input.getPokemon) {
    if (byslug.get(slug)?.teamId !== input.toTeamId) {
      throw new TradeError(`They no longer own ${byslug.get(slug)?.pokemon.name ?? slug}.`);
    }
  }

  return db.$transaction(async (tx) => {
    const offer = await tx.tradeOffer.create({
      data: {
        leagueId: input.leagueId,
        fromTeamId: input.fromTeamId,
        toTeamId: input.toTeamId,
        cash: input.cash,
        note: input.note?.trim() || null,
        items: {
          create: [
            ...input.givePokemon.map((slug) => ({ side: 'FROM', pokemonSlug: slug })),
            ...input.getPokemon.map((slug) => ({ side: 'TO', pokemonSlug: slug })),
          ],
        },
      },
      include: { items: true },
    });

    await audit(tx, {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId,
      action: 'TRADE_PROPOSE',
      detail: { offerId: offer.id },
    });

    return offer;
  });
}

export async function respondToTrade(input: {
  offerId: string;
  accept: boolean;
  actorUserId: string;
  /** The team responding — must be the recipient to accept. */
  teamId: string;
}) {
  return db.$transaction(async (tx) => {
    const offer = await tx.tradeOffer.findUniqueOrThrow({
      where: { id: input.offerId },
      include: { items: true },
    });

    if (offer.status !== 'PENDING') throw new TradeError('That offer has already been resolved.');

    if (!input.accept) {
      const isParty = input.teamId === offer.toTeamId || input.teamId === offer.fromTeamId;
      if (!isParty) throw new TradeError('That offer is not yours to decline.');
      await tx.tradeOffer.update({
        where: { id: offer.id },
        data: {
          status: input.teamId === offer.fromTeamId ? 'CANCELLED' : 'REJECTED',
          resolvedAt: new Date(),
        },
      });
      return { accepted: false };
    }

    if (input.teamId !== offer.toTeamId) throw new TradeError('Only the recipient can accept.');

    // Declining is always allowed; it is completing the deal that a freeze stops. An offer made
    // before a freeze landed is still on the table, and still cannot go through.
    await assertTransfersOpen(tx, offer.leagueId, offer.fromTeamId);
    await assertTransfersOpen(tx, offer.leagueId, offer.toTeamId);

    const league = await tx.league.findUniqueOrThrow({ where: { id: offer.leagueId } });
    const config = parseConfig(league.config);

    const giving = offer.items.filter((item) => item.side === 'FROM').map((i) => i.pokemonSlug);
    const getting = offer.items.filter((item) => item.side === 'TO').map((i) => i.pokemonSlug);

    // Move each Pokémon, asserting the expected owner still holds it.
    for (const [slug, from, to] of [
      ...giving.map((s) => [s, offer.fromTeamId, offer.toTeamId] as const),
      ...getting.map((s) => [s, offer.toTeamId, offer.fromTeamId] as const),
    ]) {
      const row = await tx.ownership.findUniqueOrThrow({
        where: { leagueId_pokemonSlug: { leagueId: offer.leagueId, pokemonSlug: slug } },
      });

      const moved = await tx.ownership.updateMany({
        where: { leagueId: offer.leagueId, pokemonSlug: slug, teamId: from },
        data: {
          teamId: to,
          status: 'OWNED',
          // The value travels with the Pokémon; what the new owner "paid" is what it was worth.
          acquiredPrice: row.marketValue,
          acquiredAt: new Date(),
          // Arrives as a reserve: the receiving manager picks their own six.
          starter: false,
          slot: null,
          captain: false,
        },
      });
      if (moved.count !== 1) {
        throw new OwnershipConflict('One of those Pokémon changed hands — the trade is off.');
      }
      await tx.valueChange.create({
        data: {
          leagueId: offer.leagueId,
          teamId: to,
          pokemonSlug: slug,
          reason: 'TRADE',
          delta: 0,
          valueAfter: row.marketValue,
          round: league.round,
        },
      });
    }

    if (offer.cash !== 0) {
      await postEntry(tx, {
        leagueId: offer.leagueId,
        teamId: offer.fromTeamId,
        type: 'TRADE',
        amount: -offer.cash,
        description: 'Trade settlement',
        relatedId: offer.id,
      });
      await postEntry(tx, {
        leagueId: offer.leagueId,
        teamId: offer.toTeamId,
        type: 'TRADE',
        amount: offer.cash,
        description: 'Trade settlement',
        relatedId: offer.id,
      });
    }

    // Both squads must still be legal afterwards.
    for (const teamId of [offer.fromTeamId, offer.toTeamId]) {
      const squadSize = await tx.ownership.count({ where: { teamId } });
      if (squadSize > config.squadMax) {
        throw new RosterRuleViolation('That trade would overfill a squad.');
      }
    }

    await tx.tradeOffer.update({
      where: { id: offer.id },
      data: { status: 'ACCEPTED', resolvedAt: new Date() },
    });

    await audit(tx, {
      leagueId: offer.leagueId,
      actorUserId: input.actorUserId,
      action: 'TRADE_ACCEPT',
      detail: { offerId: offer.id, giving, getting, cash: offer.cash },
    });

    return { accepted: true };
  });
}

export async function getTrades(leagueId: string, teamId: string) {
  return db.tradeOffer.findMany({
    where: { leagueId, OR: [{ fromTeamId: teamId }, { toTeamId: teamId }] },
    include: { items: true, fromTeam: true, toTeam: true },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
}
