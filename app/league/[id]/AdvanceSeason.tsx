'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { advanceSeasonAction, type ActionState } from '../../actions/market.ts';
import { Button } from '../../components/ui.tsx';

function Submit({ season }: { season: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending} className="w-full">
      {pending ? 'Closing the season…' : `Yes, end season ${season}`}
    </Button>
  );
}

/**
 * Ending the season, behind a second click. It sells nearly every Pokémon in the league and
 * resets every rank, and none of that comes back — so it must never happen by a stray tap.
 */
export function AdvanceSeason({ leagueId, season }: { leagueId: string; season: number }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(advanceSeasonAction, {});

  if (state.success) {
    return (
      <p className="rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
        {state.success}
      </p>
    );
  }

  if (!confirming) {
    return (
      <Button type="button" variant="ghost" className="w-full" onClick={() => setConfirming(true)}>
        End season {season}…
      </Button>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leagueId" value={leagueId} />
      <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
        Every club goes back to Poké Ball 4, and every Pokémon except each club&rsquo;s captain is
        sold back to the market at its current value. The league then waits for you to run a new
        draft. This can&rsquo;t be undone.
      </p>
      {state.error && <p className="text-sm text-negative">{state.error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Submit season={season} />
      </div>
    </form>
  );
}
