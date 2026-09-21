'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { allRungs, getTier, progressPerRank } from '../../../../lib/ladder.ts';
import { updateStandingAction, type ActionState } from '../../../actions/market.ts';
import { Button, Field, inputClass } from '../../../components/ui.tsx';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Saving…' : 'Update my rank'}
    </Button>
  );
}

/**
 * Self-reported ladder standing.
 *
 * The game is the authority here — the app just records what you're actually sitting at, which
 * is why this is a plain form rather than something derived from the matches you've logged.
 */
export function StandingForm({
  leagueId,
  teamId,
  current,
}: {
  leagueId: string;
  teamId: string;
  current: {
    tierKey: string;
    rank: number | null;
    progress: number;
    ratingPoints: number | null;
    globalPlacement: number | null;
  };
}) {
  const rungs = allRungs();
  // Champions starts everyone at Poké Ball 4, so default there rather than to Beginner — which
  // has no ranks and would render an empty "0–0" progress gauge.
  const [rung, setRung] = useState(
    current.tierKey === 'beginner' ? 'poke:4' : `${current.tierKey}:${current.rank ?? ''}`,
  );
  const [progress, setProgress] = useState(current.progress);
  const [state, action] = useActionState<ActionState, FormData>(updateStandingAction, {});

  const [tierKey] = rung.split(':');
  const tier = getTier(tierKey);
  const rated = Boolean(tier.rated);
  // Gauge length is per tier — Poké Ball 3, Great Ball 4, Ultra Ball 5.
  const gauge = progressPerRank(tierKey);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="leagueId" value={leagueId} />
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="rung" value={rung} />

      <Field label="Current rank">
        <select value={rung} onChange={(event) => setRung(event.target.value)} className={inputClass}>
          {rungs.map((option) => (
            <option key={`${option.tierKey}:${option.rank ?? ''}`} value={`${option.tierKey}:${option.rank ?? ''}`}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {rated ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rating points" hint="e.g. 1703.462">
            <input
              name="ratingPoints"
              type="number"
              step="0.001"
              defaultValue={current.ratingPoints ?? ''}
              className={inputClass}
              placeholder="1703.462"
            />
          </Field>
          <Field label="Global placement" hint="e.g. 123329">
            <input
              name="globalPlacement"
              type="number"
              min={1}
              defaultValue={current.globalPlacement ?? ''}
              className={inputClass}
              placeholder="123329"
            />
          </Field>
        </div>
      ) : gauge === 0 ? null : (
        <Field label={`Progress toward the next rank (0–${gauge})`}>
          <div className="flex items-center gap-2">
            <input type="hidden" name="progress" value={Math.min(progress, gauge)} />
            {Array.from({ length: gauge + 1 }, (_, value) => (
              <button
                key={value}
                type="button"
                onClick={() => setProgress(value)}
                className={`h-9 flex-1 rounded-md border text-sm font-semibold transition ${
                  Math.min(progress, gauge) === value
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line bg-panel-2 text-muted hover:text-ink'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </Field>
      )}

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
  );
}
