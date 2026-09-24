'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { placeBidAction, type ActionState } from '../../../actions/events.ts';
import { money } from '../../../../lib/format.ts';
import { Button, inputClass } from '../../../components/ui.tsx';
import type { OptionView } from './EventCard.tsx';

function Submit({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} className="shrink-0">
      {pending ? 'Placing…' : 'Place sealed bid'}
    </Button>
  );
}

/**
 * One event on the board, as this club would face it, and the club's one bid on it.
 *
 * The branches are shown in full, costs and all, because a bid is a price on exactly those —
 * and they are not buttons, because nothing is decided until the board closes and the club has
 * won it. A bid asks for a second click: it cannot be changed, and a stray Enter should not be
 * the way a manager learns that.
 */
export function BoardCard({
  leagueId,
  auctionId,
  title,
  description,
  options,
  announcement,
  closedReason,
  myBid,
  bidMax,
}: {
  leagueId: string;
  auctionId: string;
  title: string;
  description: string;
  options: OptionView[];
  announcement: boolean;
  closedReason: string | null;
  myBid: number | null;
  bidMax: number;
}) {
  const [state, action] = useActionState<ActionState, FormData>(placeBidAction, {});
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);

  const value = Number(amount);
  const valid = amount !== '' && Number.isInteger(value) && value >= 0 && value <= bidMax;
  const placed = myBid ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel-2 p-4">
      <div>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
      </div>

      {announcement ? (
        <p className="text-xs text-muted italic">
          Nothing to choose: whoever takes this on lives with it as written.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {options.map((option) => (
            <li key={option.key} className="rounded-lg border border-line bg-panel px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-ink">
                  {option.label}
                  {option.default && <span className="ml-2 text-[11px] text-muted">always open</span>}
                </span>
                {option.cost > 0 && (
                  <span className="tabular shrink-0 text-sm text-negative">{money(option.cost)}</span>
                )}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{option.detail}</p>
              {!option.available && option.unavailableReason && (
                <p className="mt-0.5 text-xs text-muted italic">
                  Closed to you today: {option.unavailableReason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {placed !== null ? (
        <p className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">
          Your bid: <strong className="tabular">{money(placed)}</strong>. Sealed and final.
        </p>
      ) : closedReason ? (
        <p className="text-xs text-muted italic">Your club can&rsquo;t bid on this: {closedReason}</p>
      ) : (
        <form
          action={action}
          onSubmit={(event) => {
            if (!confirming) {
              event.preventDefault();
              if (valid) setConfirming(true);
            }
          }}
          className="flex flex-col gap-2"
        >
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="auctionId" value={auctionId} />
          <label className="text-xs text-muted" htmlFor={`bid-${auctionId}`}>
            What would you want to be paid to take this on? Up to {money(bidMax)}.
          </label>
          <div className="flex gap-2">
            <input
              id={`bid-${auctionId}`}
              name="amount"
              type="number"
              inputMode="numeric"
              min={0}
              max={bidMax}
              step={1}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setConfirming(false);
              }}
              className={inputClass}
              placeholder="₽"
            />
            {confirming ? (
              <Submit disabled={!valid} />
            ) : (
              <Button type="submit" variant="ghost" disabled={!valid} className="shrink-0">
                Bid
              </Button>
            )}
          </div>
          {confirming && (
            <p className="text-xs text-accent">
              {money(value)} — once placed it can&rsquo;t be changed or withdrawn.
            </p>
          )}
          {state.error && <p className="text-sm text-negative">{state.error}</p>}
        </form>
      )}
      {state.success && placed === null && <p className="text-sm text-positive">{state.success}</p>}
    </div>
  );
}
