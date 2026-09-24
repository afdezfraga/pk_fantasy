'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { createLeagueAction, joinLeagueAction, type FormState } from './actions/league.ts';
import { BoardFields } from './components/BoardFields.tsx';
import { Button, ErrorNote, Field, Panel, inputClass } from './components/ui.tsx';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Working…' : label}
    </Button>
  );
}

export function LobbyForms() {
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [createState, createAction] = useActionState<FormState, FormData>(createLeagueAction, {});
  const [joinState, joinAction] = useActionState<FormState, FormData>(joinLeagueAction, {});

  return (
    <Panel
      title={tab === 'create' ? 'Start a league' : 'Join a league'}
      action={
        <button
          type="button"
          onClick={() => setTab(tab === 'create' ? 'join' : 'create')}
          className="text-xs font-medium text-accent hover:underline"
        >
          {tab === 'create' ? 'Have an invite code?' : 'Start one instead'}
        </button>
      }
    >
      {tab === 'create' ? (
        <form action={createAction} className="flex flex-col gap-3">
          <Field label="League name">
            <input name="name" required className={inputClass} placeholder="Thursday Night Champions" />
          </Field>
          <Field label="Your team name">
            <input name="teamName" required className={inputClass} placeholder="Pallet Town Pidgeots" />
          </Field>
          <details className="rounded-lg border border-line bg-panel-2 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-ink">Event board</summary>
            <p className="mt-2 text-xs text-muted">
              Events go up on a board and clubs bid, sealed, for how little they&rsquo;d take to be
              paid to live with one. Lowest bid wins it. You can change these later.
            </p>
            <BoardFields />
          </details>
          <ErrorNote>{createState.error}</ErrorNote>
          <p className="text-xs text-muted">
            You'll be the commissioner: you set the rules, run the draft and advance the rounds.
          </p>
          <Submit label="Create league" />
        </form>
      ) : (
        <form action={joinAction} className="flex flex-col gap-3">
          <Field label="Invite code">
            <input
              name="inviteCode"
              required
              maxLength={12}
              autoCapitalize="characters"
              className={`${inputClass} font-mono uppercase tracking-widest`}
              placeholder="ABC234"
            />
          </Field>
          <Field label="Your team name">
            <input name="teamName" required className={inputClass} placeholder="Cerulean Gyarados" />
          </Field>
          <ErrorNote>{joinState.error}</ErrorNote>
          <Submit label="Join league" />
        </form>
      )}
    </Panel>
  );
}
