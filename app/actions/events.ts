'use server';

import { revalidatePath } from 'next/cache';

import { requireUser } from '../../lib/auth/session.ts';
import { db } from '../../lib/db.ts';
import { money } from '../../lib/format.ts';
import { EffectViolation } from '../../lib/services/effects.ts';
import { EventError, resolveEvent } from '../../lib/services/events.ts';
import { LeagueError } from '../../lib/services/league.ts';
import { InsufficientFunds } from '../../lib/services/money.ts';

export interface ActionState {
  error?: string;
  success?: string;
}

const KNOWN_ERRORS = [EventError, EffectViolation, LeagueError, InsufficientFunds];

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
