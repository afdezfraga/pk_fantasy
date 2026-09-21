/**
 * Every movement of money goes through here.
 *
 * `Team.cash` is a cached balance and the `Transaction` ledger is the truth. Keeping both in
 * step is only safe if nothing else ever writes `cash` directly — so nothing else does.
 */

import type { Prisma } from '@prisma/client';

export type TransactionType =
  | 'DRAFT_PICK'
  | 'MARKET_BUY'
  | 'MARKET_SELL'
  | 'TRADE'
  | 'MATCH_PAYOUT'
  | 'SALARY'
  | 'EVENT'
  | 'ADJUSTMENT';

export interface PostEntry {
  leagueId: string;
  /** Null posts against the league bank, which has no cash balance to maintain. */
  teamId: string | null;
  type: TransactionType;
  /** Signed: negative takes money off the team. */
  amount: number;
  description: string;
  relatedId?: string;
}

export class InsufficientFunds extends Error {
  constructor(shortfall: number) {
    super(`Not enough money — you're short ₽${shortfall.toLocaleString()}.`);
    this.name = 'InsufficientFunds';
  }
}

/**
 * Posts one ledger entry and moves the team's cached balance to match.
 *
 * Must be called inside a transaction alongside whatever it is paying for, so that a failure
 * anywhere rolls back the money too.
 */
export async function postEntry(
  tx: Prisma.TransactionClient,
  entry: PostEntry,
  options: {
    /**
     * Let the balance go negative.
     *
     * Only for charges a team cannot decline — salaries, chiefly. A team that can't make
     * payroll goes into debt rather than blocking the charge, because the alternative is a
     * round that can never be closed and a league that is stuck forever. Debt is then its own
     * punishment: `acquireFreeAgent` requires positive funds, so you can't sign anyone until
     * you've sold your way back into the black.
     */
    allowNegative?: boolean;
  } = {},
): Promise<number> {
  if (!Number.isInteger(entry.amount)) {
    throw new Error(`Ledger amounts must be whole Pokédollars, got ${entry.amount}.`);
  }

  // The league bank is unbounded and has no cached balance to keep.
  if (entry.teamId === null) {
    await tx.transaction.create({
      data: { ...entry, teamId: null, balanceAfter: 0 },
    });
    return 0;
  }

  // Guarded update: for a debit, only succeeds if the team can actually afford it. Doing the
  // check inside the UPDATE rather than as a separate read closes the gap where two concurrent
  // purchases each see enough money and both go through.
  const guard: Prisma.TeamWhereInput =
    entry.amount < 0 && !options.allowNegative
      ? { id: entry.teamId, cash: { gte: -entry.amount } }
      : { id: entry.teamId };

  const updated = await tx.team.updateMany({
    where: guard,
    data: { cash: { increment: entry.amount } },
  });

  if (updated.count !== 1) {
    const team = await tx.team.findUnique({ where: { id: entry.teamId } });
    if (!team) throw new Error('Team not found.');
    throw new InsufficientFunds(-entry.amount - team.cash);
  }

  const team = await tx.team.findUniqueOrThrow({
    where: { id: entry.teamId },
    select: { cash: true },
  });

  await tx.transaction.create({ data: { ...entry, balanceAfter: team.cash } });
  return team.cash;
}

/** Records who did what, for a league where results are reported on the honour system. */
export async function audit(
  tx: Prisma.TransactionClient,
  input: { leagueId: string; actorUserId?: string | null; action: string; detail: unknown },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      leagueId: input.leagueId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      detail: JSON.stringify(input.detail),
    },
  });
}

export interface LedgerDiscrepancy {
  teamId: string;
  teamName: string;
  cash: number;
  ledgerTotal: number;
}

/**
 * Asserts every team's cached balance equals the sum of its ledger.
 *
 * Run from tests and from the commissioner's admin page. If this ever disagrees, something has
 * written `cash` outside `postEntry` and the ledger is the one to believe.
 */
export async function verifyLedger(
  client: Prisma.TransactionClient,
  leagueId: string,
): Promise<LedgerDiscrepancy[]> {
  const teams = await client.team.findMany({
    where: { leagueId },
    select: { id: true, name: true, cash: true },
  });

  const sums = await client.transaction.groupBy({
    by: ['teamId'],
    where: { leagueId, teamId: { not: null } },
    _sum: { amount: true },
  });
  const byTeam = new Map(sums.map((row) => [row.teamId, row._sum.amount ?? 0]));

  return teams
    .map((team) => ({
      teamId: team.id,
      teamName: team.name,
      cash: team.cash,
      ledgerTotal: byTeam.get(team.id) ?? 0,
    }))
    .filter((row) => row.cash !== row.ledgerTotal);
}
