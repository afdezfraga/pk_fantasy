'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { startDraftAction, type FormState } from '../../actions/league.ts';
import { Button, ErrorNote, Field, inputClass } from '../../components/ui.tsx';

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} className="w-full">
      {pending ? 'Setting up…' : 'Start the draft'}
    </Button>
  );
}

export function StartDraftForm({
  leagueId,
  teamCount,
  defaultRounds,
}: {
  leagueId: string;
  teamCount: number;
  defaultRounds: number;
}) {
  const [state, action] = useActionState<FormState, FormData>(startDraftAction, {});
  const tooFewTeams = teamCount < 1;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leagueId" value={leagueId} />
      <Field
        label="Rounds"
        hint={`Each team ends up with this many Pokémon. ${teamCount} team${
          teamCount === 1 ? '' : 's'
        } in the league.`}
      >
        <input
          name="rounds"
          type="number"
          min={1}
          max={20}
          defaultValue={defaultRounds}
          className={inputClass}
        />
      </Field>
      <ErrorNote>{state.error}</ErrorNote>
      {teamCount === 1 && (
        <p className="text-xs text-muted">
          Running solo — the draft just becomes picking your own squad, and you can start the
          league on your own.
        </p>
      )}
      <p className="text-xs text-muted">
        Snake order, randomised. Teams pay market value for each pick, so budget and cap bite
        from pick one — spend it all on three stars and you'll sit out the rest of the draft with
        a squad of three.
      </p>
      <Submit disabled={tooFewTeams} />
    </form>
  );
}
