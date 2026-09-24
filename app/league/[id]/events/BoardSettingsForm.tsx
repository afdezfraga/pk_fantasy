'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { updateBoardSettingsAction, type ActionState } from '../../../actions/events.ts';
import { BoardFields } from '../../../components/BoardFields.tsx';
import { Button } from '../../../components/ui.tsx';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}

/** The commissioner's dials for the board. A change waits for the next board to go up. */
export function BoardSettingsForm({
  leagueId,
  values,
}: {
  leagueId: string;
  values: { eventBoardHours: number; eventBoardSize: number; eventBidMax: number };
}) {
  const [state, action] = useActionState<ActionState, FormData>(updateBoardSettingsAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leagueId" value={leagueId} />
      <BoardFields values={values} />
      <div className="flex items-center gap-3">
        <Submit />
        {state.error && <p className="text-sm text-negative">{state.error}</p>}
        {state.success && <p className="text-sm text-positive">{state.success}</p>}
      </div>
    </form>
  );
}
