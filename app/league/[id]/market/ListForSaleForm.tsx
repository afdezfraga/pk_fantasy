'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { listForSaleAction, type ActionState } from '../../../actions/market.ts';
import { Button, ErrorNote, Field, inputClass } from '../../../components/ui.tsx';

export interface SellableRow {
  slug: string;
  label: string;
  /** What it is worth today — the anchor a manager prices against. */
  value: number;
}

/** The windows on offer. An hour is a real tactic; a week is as long as anything should sit. */
const WINDOWS = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="shrink-0">
      {pending ? 'Posting…' : 'Put on the board'}
    </Button>
  );
}

/**
 * Posting one of your own Pokémon to the open board.
 *
 * Lives on the market page rather than the squad page because the thing it produces appears
 * here: you set a price, and the next screen down is where everyone else sees it.
 */
export function ListForSaleForm({
  leagueId,
  squad,
}: {
  leagueId: string;
  squad: SellableRow[];
}) {
  const [state, act] = useActionState<ActionState, FormData>(listForSaleAction, {});
  const [slug, setSlug] = useState(squad[0]?.slug ?? '');

  if (squad.length === 0) {
    return <p className="text-sm text-muted">Nothing to sell — your squad is empty.</p>;
  }

  const picked = squad.find((row) => row.slug === slug);

  return (
    <form action={act} className="flex flex-col gap-3">
      <input type="hidden" name="leagueId" value={leagueId} />

      <Field label="Pokémon">
        <select
          name="pokemonSlug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          className={inputClass}
        >
          {squad.map((row) => (
            <option key={row.slug} value={row.slug}>
              {row.label} — worth ₽{row.value.toLocaleString()}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-wrap gap-3">
        <div className="min-w-[8rem] flex-1">
          <Field label="Asking price" hint="Frozen once it is up.">
            <input
              name="price"
              type="number"
              min={0}
              step={1000}
              defaultValue={picked?.value ?? 0}
              key={slug}
              className={inputClass}
              required
            />
          </Field>
        </div>
        <div className="min-w-[8rem] flex-1">
          <Field label="Stays up for">
            <select name="hours" defaultValue={24} className={inputClass}>
              {WINDOWS.map((window) => (
                <option key={window.hours} value={window.hours}>
                  {window.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      {state.success ? <p className="text-sm text-positive">{state.success}</p> : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          Any club may take it at that price. You can pull it back whenever you like.
        </p>
        <Submit />
      </div>
    </form>
  );
}
