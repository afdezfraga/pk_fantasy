/**
 * Writing an owned Pokémon's value. Everything that moves `Ownership.marketValue` on an owned
 * Pokémon goes through `recordValue`, so the `ValueChange` trail always explains the number.
 */

import type { Prisma } from '@prisma/client';

export type ValueReason = 'BUY' | 'WIN' | 'LOSS' | 'SELL' | 'TRADE' | 'EVENT';

export async function recordValue(
  tx: Prisma.TransactionClient,
  input: {
    ownershipId: string;
    leagueId: string;
    teamId: string | null;
    pokemonSlug: string;
    reason: ValueReason;
    from: number;
    to: number;
    pct?: number;
    matchId?: string;
    round?: number;
  },
): Promise<void> {
  await tx.ownership.update({ where: { id: input.ownershipId }, data: { marketValue: input.to } });
  await tx.valueChange.create({
    data: {
      leagueId: input.leagueId,
      teamId: input.teamId,
      pokemonSlug: input.pokemonSlug,
      matchId: input.matchId ?? null,
      reason: input.reason,
      pct: input.pct ?? 0,
      delta: input.to - input.from,
      valueAfter: input.to,
      round: input.round ?? 1,
    },
  });
}
