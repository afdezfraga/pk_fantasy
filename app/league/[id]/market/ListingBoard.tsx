'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { money } from '../../../../lib/format.ts';
import { buyListingAction, type ActionState } from '../../../actions/market.ts';
import { PokemonIcon } from '../../../components/PokemonImage.tsx';
import { Button, TierBadge } from '../../../components/ui.tsx';

export interface ListingRow {
  id: string;
  slug: string;
  label: string;
  tier: string;
  iconUrl: string | null;
  /** What the board asks. Frozen when the listing opened. */
  price: number;
  /** What it is worth to whoever owns it, for comparison against the asking price. */
  value: number;
  sellerName: string;
  mine: boolean;
  /** True when a decision put it here rather than the manager choosing to sell. */
  fromEvent: boolean;
  /** When it comes off the board, as a date the page can print. */
  openUntil: string;
}

function Submit({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending || disabled} className="shrink-0">
      {pending ? 'Working…' : children}
    </Button>
  );
}

/**
 * Pokémon any club may simply take, at the price on the board.
 *
 * Deliberately its own panel rather than a column in the market table: the asking price is not
 * the shop price and not the market value, and a row that showed all three in the same grid
 * would be read wrong by somebody in a hurry.
 */
export function ListingBoard({
  leagueId,
  listings,
  cash,
  canBuy,
}: {
  leagueId: string;
  listings: ListingRow[];
  cash: number;
  canBuy: boolean;
}) {
  const [buyState, buy] = useActionState<ActionState, FormData>(buyListingAction, {});
  const message = buyState.error ?? buyState.success;
  const failed = Boolean(buyState.error);

  if (listings.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing is on the board. A Pokémon lands here when a club puts it up — or when one asks
        what else is out there and its manager lets it find out.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {message && (
        <p className={`text-sm ${failed ? 'text-negative' : 'text-positive'}`}>{message}</p>
      )}

      <ul className="flex flex-col rounded-lg border border-line bg-panel-2">
        {listings.map((listing) => {
          const premium = listing.price - listing.value;
          const affordable = cash >= listing.price;

          return (
            <li
              key={listing.id}
              className="flex flex-col gap-2 border-b border-line px-3 py-2.5 last:border-0"
            >
              <div className="flex items-center gap-3">
                <PokemonIcon icon={listing.iconUrl} alt={listing.label} size={36} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">
                      {listing.label}
                    </span>
                    <TierBadge tier={listing.tier} />
                  </div>
                  <div className="truncate text-xs text-muted">
                    {listing.mine ? 'Yours' : listing.sellerName}
                    {listing.fromEvent && ' · asked to leave'}
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  <div className="tabular text-sm font-semibold text-ink">
                    {money(listing.price)}
                  </div>
                  <div className="tabular text-[11px] text-muted">
                    worth {money(listing.value)}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                  {premium > 0 && `${money(premium)} over · `}
                  on the board until {listing.openUntil}
                </span>

                {listing.mine ? (
                  // No take-backs. A listing you could pull the moment somebody showed interest
                  // would be a way of finding out what your rivals want without ever selling.
                  <span className="shrink-0 text-xs text-muted italic">Committed</span>
                ) : (
                  <form action={buy}>
                    <input type="hidden" name="leagueId" value={leagueId} />
                    <input type="hidden" name="listingId" value={listing.id} />
                    {/* Priced out is shown rather than hidden: knowing what you cannot afford
                        is half of what a market board is for. */}
                    <Submit disabled={!canBuy || !affordable}>
                      {affordable ? 'Sign' : 'Too dear'}
                    </Submit>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
