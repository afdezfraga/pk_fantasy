'use client';

import { useActionState } from 'react';

import { finishDraftAction, type FormState } from '../../../actions/league.ts';
import { Button, ErrorNote } from '../../../components/ui.tsx';

/** Commissioner's escape hatch: end the draft wherever it has got to. */
export function FinishDraft({ leagueId }: { leagueId: string }) {
  const [state, action] = useActionState<FormState, FormData>(finishDraftAction, {});

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leagueId" value={leagueId} />
      <p className="text-xs text-muted">
        Everyone has what they want, or someone's stuck? End the draft here and start the season
        — the rest of the pool stays available on the market.
      </p>
      <ErrorNote>{state.error}</ErrorNote>
      <Button type="submit" variant="ghost">
        End the draft now
      </Button>
    </form>
  );
}
