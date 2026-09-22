'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  delegateEventAction,
  forceResolveEventAction,
  resolveEventAction,
  type ActionState,
} from '../../../actions/events.ts';
import { money } from '../../../../lib/format.ts';
import { Button } from '../../../components/ui.tsx';

export interface OptionView {
  key: string;
  label: string;
  detail: string;
  cost: number;
  available: boolean;
  unavailableReason?: string;
  default: boolean;
}

function Submit({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending || disabled} className="w-full">
      {pending ? 'Deciding…' : children}
    </Button>
  );
}

function GhostSubmit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-xs text-muted underline underline-offset-2 transition hover:text-ink disabled:opacity-40"
    >
      {pending ? 'Asking…' : children}
    </button>
  );
}

/**
 * One decision, with every consequence spelled out before it is taken.
 *
 * The cost on each button is the exact number that will be charged — it was settled when the
 * event was drawn — and an option the club cannot take is shown disabled with the reason rather
 * than failing on click.
 */
export function EventCard({
  leagueId,
  eventId,
  title,
  description,
  options,
  delegable,
  isCommissioner,
}: {
  leagueId: string;
  eventId: string;
  title: string;
  description: string;
  options: OptionView[];
  delegable: boolean;
  isCommissioner: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(resolveEventAction, {});
  const [delegateState, delegate] = useActionState<ActionState, FormData>(delegateEventAction, {});
  const [forceState, force] = useActionState<ActionState, FormData>(forceResolveEventAction, {});

  const error = state.error ?? delegateState.error ?? forceState.error;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <div>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
      </div>

      {error && <p className="text-sm text-negative">{error}</p>}

      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <form key={option.key} action={action} className="flex flex-col gap-1">
            <input type="hidden" name="leagueId" value={leagueId} />
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="choiceKey" value={option.key} />
            <div className="rounded-lg border border-line bg-panel p-3">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-ink">{option.label}</span>
                {option.cost > 0 && (
                  <span className="tabular shrink-0 text-sm text-negative">
                    {money(option.cost)}
                  </span>
                )}
              </div>
              <p className="mb-2.5 text-xs leading-relaxed text-muted">{option.detail}</p>
              {option.available ? (
                <Submit>Choose this</Submit>
              ) : (
                <p className="text-xs text-muted italic">
                  {option.unavailableReason ?? 'Not available to your club.'}
                </p>
              )}
            </div>
          </form>
        ))}
      </div>

      {/*
        Always here, always secondary. It is the guarantee that no club is ever stuck behind a
        decision it cannot afford — and the price is that your assistant picks, not you.
      */}
      {delegable && (
        <form action={delegate} className="text-center">
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="eventId" value={eventId} />
          <GhostSubmit>Let your assistant handle it</GhostSubmit>
        </form>
      )}

      {isCommissioner && (
        <form action={force} className="text-center">
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="eventId" value={eventId} />
          <GhostSubmit>Force it through (commissioner)</GhostSubmit>
        </form>
      )}
    </div>
  );
}
