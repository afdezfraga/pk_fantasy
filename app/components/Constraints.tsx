/**
 * What a club is playing under, shown everywhere it matters.
 *
 * A restriction the manager forgets about is worse than no restriction at all: they play a match
 * under rules they didn't know they had, and the app either refuses the report or silently
 * records a promise they never made. So the same strip appears on the squad board, above the
 * report form and inside every history row, and every restriction announces its own end.
 */

import type { MatchConstraint } from '../../lib/services/effects.ts';

export interface ConstraintView {
  id: string;
  label: string;
  attested: boolean;
  matchesLeft: number;
}

function Countdown({ matches }: { matches: number }) {
  if (matches <= 0) return null;
  return (
    <span className="tabular shrink-0 text-[11px] text-muted">
      {matches === 1 ? 'last match' : `${matches} matches left`}
    </span>
  );
}

/** The live strip: what is in force right now, and for how much longer. */
export function Constraints({
  constraints,
  title = 'In force',
}: {
  constraints: ConstraintView[];
  title?: string;
}) {
  if (constraints.length === 0) return null;

  return (
    <div className="rounded-lg border border-negative/40 bg-negative/5 px-3 py-2.5">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-negative">
        {title}
      </div>
      <ul className="flex flex-col gap-1">
        {constraints.map((constraint) => (
          <li key={constraint.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink">
              {constraint.label}
              {/* Saying which ones the app cannot check is the honest version of an honour rule. */}
              {constraint.attested && (
                <span className="ml-1.5 text-[11px] text-muted">· on your word</span>
              )}
            </span>
            <Countdown matches={constraint.matchesLeft} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The frozen record on a played match — what that result was achieved under. */
export function PlayedUnder({ constraints }: { constraints: MatchConstraint[] }) {
  if (constraints.length === 0) return null;

  return (
    <p className="mt-1 text-[11px] leading-relaxed text-muted">
      {constraints.map((constraint, index) => (
        <span key={`${constraint.kind}-${index}`}>
          {index > 0 && ' · '}
          <span className={constraint.honoured === false ? 'text-negative' : undefined}>
            {constraint.label}
            {constraint.honoured === false && ' (not confirmed)'}
          </span>
        </span>
      ))}
    </p>
  );
}

/** A restriction that has just ended. Shown once, because nobody watches a number tick down. */
export function Lifted({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;

  return (
    <div className="rounded-lg border border-positive/40 bg-positive/10 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-positive">
        Restriction lifted
      </div>
      {messages.map((message) => (
        <p key={message} className="text-sm text-ink">
          {message}
        </p>
      ))}
    </div>
  );
}
