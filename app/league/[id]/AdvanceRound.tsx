'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { advanceRoundAction, type ActionState } from '../../actions/market.ts';
import { Button } from '../../components/ui.tsx';

function Submit({ round }: { round: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending} className="w-full">
      {pending ? 'Closing the round…' : `Close round ${round}`}
    </Button>
  );
}

export function AdvanceRound({ leagueId, round }: { leagueId: string; round: number }) {
  const [state, action] = useActionState<ActionState, FormData>(advanceRoundAction, {});

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="leagueId" value={leagueId} />
      <p className="text-xs text-muted">
        The round closes by itself once enough clubs have played it out. Closing it early releases
        anyone on waivers back to the market and starts everyone&rsquo;s match pay allowance
        again. Nobody is charged for anything.
      </p>
      {state.error && <p className="text-sm text-negative">{state.error}</p>}
      {state.success && (
        <p className="rounded-lg border border-positive/40 bg-positive/10 px-3 py-2 text-sm text-positive">
          {state.success}
        </p>
      )}
      <Submit round={round} />
    </form>
  );
}
