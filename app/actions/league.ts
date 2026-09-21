'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireUser } from '../../lib/auth/session.ts';
import { createLeague, joinLeague, LeagueError } from '../../lib/services/league.ts';
import { finishDraft, makePick, passPick, startDraft, DraftError } from '../../lib/services/draft.ts';
import { OwnershipConflict, RosterRuleViolation } from '../../lib/services/ownership.ts';
import { InsufficientFunds } from '../../lib/services/money.ts';

export interface FormState {
  error?: string;
}

/** Turns our domain errors into something worth showing a player, and lets the rest bubble. */
function toMessage(error: unknown): string {
  if (
    error instanceof LeagueError ||
    error instanceof DraftError ||
    error instanceof OwnershipConflict ||
    error instanceof RosterRuleViolation ||
    error instanceof InsufficientFunds
  ) {
    return error.message;
  }
  throw error;
}

export async function createLeagueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const name = String(formData.get('name') ?? '').trim();
  const teamName = String(formData.get('teamName') ?? '').trim();

  if (name.length < 3) return { error: 'Give the league a name of at least 3 characters.' };
  if (teamName.length < 2) return { error: 'Give your team a name.' };

  let leagueId: string;
  try {
    const { league } = await createLeague({ name, commissionerId: user.id, teamName });
    leagueId = league.id;
  } catch (error) {
    return { error: toMessage(error) };
  }

  redirect(`/league/${leagueId}`);
}

export async function joinLeagueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const inviteCode = String(formData.get('inviteCode') ?? '').trim();
  const teamName = String(formData.get('teamName') ?? '').trim();

  if (!inviteCode) return { error: 'Enter the invite code.' };
  if (teamName.length < 2) return { error: 'Give your team a name.' };

  let leagueId: string;
  try {
    const { league } = await joinLeague({ inviteCode, userId: user.id, teamName });
    leagueId = league.id;
  } catch (error) {
    return { error: toMessage(error) };
  }

  redirect(`/league/${leagueId}`);
}

export async function startDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const roundsRaw = String(formData.get('rounds') ?? '');
  const rounds = roundsRaw ? Number.parseInt(roundsRaw, 10) : undefined;

  if (rounds !== undefined && (!Number.isFinite(rounds) || rounds < 1 || rounds > 20)) {
    return { error: 'Rounds must be between 1 and 20.' };
  }

  try {
    await startDraft({ leagueId, actorUserId: user.id, rounds });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/league/${leagueId}/draft`);
  redirect(`/league/${leagueId}/draft`);
}

export async function makePickAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const teamId = String(formData.get('teamId') ?? '');
  const pokemonSlug = String(formData.get('pokemonSlug') ?? '');

  try {
    await makePick({ leagueId, teamId, pokemonSlug, actorUserId: user.id });
  } catch (error) {
    return { error: toMessage(error) };
  }

  revalidatePath(`/league/${leagueId}/draft`);
  revalidatePath(`/league/${leagueId}/squad`);
  revalidatePath(`/league/${leagueId}`);
  return {};
}

export async function passPickAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const teamId = String(formData.get('teamId') ?? '');

  try {
    await passPick({ leagueId, teamId, actorUserId: user.id });
  } catch (error) {
    return { error: toMessage(error) };
  }
  revalidatePath(`/league/${leagueId}/draft`);
  return {};
}

export async function finishDraftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');

  try {
    await finishDraft({ leagueId, actorUserId: user.id });
  } catch (error) {
    return { error: toMessage(error) };
  }
  revalidatePath(`/league/${leagueId}/draft`);
  revalidatePath(`/league/${leagueId}`);
  redirect(`/league/${leagueId}`);
}
