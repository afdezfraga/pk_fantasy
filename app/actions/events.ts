'use server';

import { revalidatePath } from 'next/cache';

import { requireUser } from '../../lib/auth/session.ts';
import { db } from '../../lib/db.ts';
import { money } from '../../lib/format.ts';
import { BoardError, placeBid } from '../../lib/services/board.ts';
import { EffectViolation } from '../../lib/services/effects.ts';
import { EventError, resolveEvent } from '../../lib/services/events.ts';
import { LeagueError, updateBoardSettings } from '../../lib/services/league.ts';
import { InsufficientFunds } from '../../lib/services/money.ts';

export interface ActionState {
  error?: string;
  success?: string;
}

const KNOWN_ERRORS = [EventError, EffectViolation, LeagueError, InsufficientFunds, BoardError];

function toMessage(error: unknown): string {
  if (KNOWN_ERRORS.some((type) => error instanceof type)) return (error as Error).message;
  throw error;
}

async function myTeam(leagueId: string, userId: string) {
  const team = await db.team.findUnique({ where: { leagueId_userId: { leagueId, userId } } });
  if (!team) throw new LeagueError("You don't have a team in this league.");
  return team;
}

/** Answering an event unblocks reporting, so every page that shows a club's state is stale. */
function refresh(leagueId: string) {
  for (const path of ['', '/events', '/matches', '/squad', '/market', '/trades']) {
    revalidatePath(`/league/${leagueId}${path}`);
  }
}

function outcome(result: { title: string; option: string; cost: number }): string {
  return result.cost > 0
    ? `${result.option} — ${money(result.cost)}.`
    : `${result.option}.`;
}

export async function resolveEventAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const eventId = String(formData.get('eventId') ?? '');
  const choiceKey = String(formData.get('choiceKey') ?? '');

  try {
    const team = await myTeam(leagueId, user.id);
    const result = await resolveEvent({ eventId, teamId: team.id, choiceKey, actorUserId: user.id });
    refresh(leagueId);
    return { success: outcome(result) };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/**
 * A sealed bid on the event board.
 *
 * The amount arrives as typed. Anything that is not a whole number of Pokédollars is refused by
 * the service rather than rounded here, because a bid is final and should be exactly what the
 * manager meant.
 */
export async function placeBidAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const auctionId = String(formData.get('auctionId') ?? '');
  const raw = String(formData.get('amount') ?? '').replace(/[₽,\s]/g, '');

  try {
    if (raw === '') throw new BoardError('Say how much you would want to be paid.');
    const team = await myTeam(leagueId, user.id);
    const amount = Number(raw);
    await placeBid({ leagueId, auctionId, teamId: team.id, amount, actorUserId: user.id });
    revalidatePath(`/league/${leagueId}/events`);
    return { success: `Bid placed: ${money(amount)}. It is sealed until the board closes.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** The commissioner changing how the board runs. Takes effect from the next board. */
export async function updateBoardSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const number = (key: string) => Number(String(formData.get(key) ?? '').replace(/[₽,\s]/g, ''));

  try {
    await updateBoardSettings({
      leagueId,
      actorUserId: user.id,
      settings: {
        eventBoardHours: number('eventBoardHours'),
        eventBoardSize: number('eventBoardSize'),
        eventBidMax: number('eventBidMax'),
      },
    });
    revalidatePath(`/league/${leagueId}/events`);
    return { success: 'Saved. The next board will run on these settings.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
