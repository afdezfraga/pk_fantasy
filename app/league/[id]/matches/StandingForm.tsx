'use client';

import { useActionState, useRef } from 'react';
import { useFormStatus } from 'react-dom';

import type { Standing } from '../../../../lib/ladder.ts';
import { updateStandingAction, type ActionState } from '../../../actions/market.ts';
import { Button } from '../../../components/ui.tsx';
import { RankFields } from './RankFields.tsx';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Saving…' : 'Save corrected rank'}
    </Button>
  );
}

/**
 * Correcting a rank by hand, behind a settings button.
 *
 * A rank normally moves with each match you report. This is for when the one on file is simply
 * wrong — you didn't start the season at Poké Ball 4, or a report got it wrong — so it lives in a
 * dialog rather than beside the report form, where it would look like the way to climb. It never
 * pays a promotion bonus.
 */
export function StandingForm({ leagueId, current }: { leagueId: string; current: Standing }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action] = useActionState<ActionState, FormData>(updateStandingAction, {});

  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-muted transition hover:text-ink"
        aria-label="Correct your rank"
        title="Correct your rank"
      >
        ⚙ Correct
      </button>

      <dialog
        ref={dialog}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-0 text-ink backdrop:bg-black/60"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Correct your rank</h2>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="text-lg leading-none text-muted hover:text-ink"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <form action={action} className="flex flex-col gap-3 p-4">
          <p className="text-xs text-muted">
            Your rank updates each time you report a match. Only use this if the rank here doesn&rsquo;t
            match the game — a different starting rank, or a mistake along the way. A correction
            never pays a promotion bonus.
          </p>
          <input type="hidden" name="leagueId" value={leagueId} />
          <RankFields key={JSON.stringify(current)} initial={current} label="Rank in the game" />

          {state.error && (
            <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
              {state.error}
            </p>
          )}
          {state.success && (
            <p className="rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
              {state.success}
            </p>
          )}

          <Submit />
        </form>
      </dialog>
    </>
  );
}
