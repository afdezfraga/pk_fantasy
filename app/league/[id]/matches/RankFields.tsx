'use client';

import { useState } from 'react';

import { allRungs, getTier, progressPerRank, type Standing } from '../../../../lib/ladder.ts';
import { Field, inputClass } from '../../../components/ui.tsx';

/**
 * Picking a ladder standing: the rank, then the gauge — or rating and placement in the rated
 * tiers. Posts `rung`, `progress`, `ratingPoints` and `globalPlacement`, which is what
 * `standingFromForm` in app/actions/market.ts reads.
 *
 * Uncontrolled from the outside: give it a `key` to reset it to a new `initial`.
 */
export function RankFields({ initial, label = 'Rank' }: { initial: Standing; label?: string }) {
  const rungs = allRungs();
  const [rung, setRung] = useState(`${initial.tierKey}:${initial.rank ?? ''}`);
  const [progress, setProgress] = useState(initial.progress);

  const [tierKey] = rung.split(':');
  const tier = getTier(tierKey);
  const rated = Boolean(tier.rated);
  // Gauge length is per tier — Poké Ball 3, Great Ball 4, Ultra Ball 5.
  const gauge = progressPerRank(tierKey);

  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name="rung" value={rung} />

      <Field label={label}>
        <select value={rung} onChange={(event) => setRung(event.target.value)} className={inputClass}>
          {rungs.map((option) => (
            <option
              key={`${option.tierKey}:${option.rank ?? ''}`}
              value={`${option.tierKey}:${option.rank ?? ''}`}
            >
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
              defaultValue={initial.ratingPoints ?? ''}
              className={inputClass}
              placeholder="1703.462"
            />
          </Field>
          <Field label="Global placement" hint="e.g. 123329">
            <input
              name="globalPlacement"
              type="number"
              min={1}
              defaultValue={initial.globalPlacement ?? ''}
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
    </div>
  );
}
