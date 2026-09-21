'use client';

import { useActionState, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { TIER_PRICE_BANDS, TIERS, VALUE_RULES, buyValue } from '../../../../config/economy.ts';
import { money, moneyShort } from '../../../../lib/format.ts';
import { buyAction, sellAction, type ActionState } from '../../../actions/market.ts';
import { PokemonIcon } from '../../../components/PokemonImage.tsx';
import { Button, TierBadge, TypePills, inputClass } from '../../../components/ui.tsx';

export interface MarketRow {
  slug: string;
  label: string;
  tier: string;
  types: string[];
  /** Shop price — what signing it costs. */
  price: number;
  /** What it is worth to its owner, and what releasing it pays. */
  value: number;
  bst: number;
  megas: string[];
  ownerName: string | null;
  ownerId: string | null;
  legal: boolean;
  /** On the roster, but transfer-only or event-only. */
  restricted: boolean;
  /** The availability caveat, e.g. "Transfer only". */
  notes: string | null;
  iconUrl: string | null;
  status: string;
}

type Filter = 'all' | 'free' | 'owned' | 'mine';
type Sort = 'price-desc' | 'price-asc' | 'name';

const TIER_ORDER = [...TIERS];

/**
 * One search box that matches a name, a type or a tier.
 *
 * People look for Pokémon three ways — "incin", "fire", "S" — and making them pick the right
 * control first is friction. Multi-word queries must all match, so "fire S" narrows to S-tier
 * Fire types.
 */
function matchesQuery(
  entry: { label: string; tier: string; types: string[] },
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [entry.label, entry.tier, ...entry.types].join(' ').toLowerCase();
  return terms.every((term) => {
    // A bare tier term should match the tier exactly, so "a" doesn't select every A-tier
    // Pokémon the moment you start typing "Arcanine".
    if (/^(s|a\+|a|b|c|d|ur)$/.test(term)) {
      return entry.tier.toLowerCase() === term || haystack.includes(term);
    }
    return haystack.includes(term);
  });
}


function SubmitButton({ label, variant }: { label: string; variant: 'primary' | 'danger' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} className="w-full">
      {pending ? 'Working…' : label}
    </Button>
  );
}

export function MarketTable({
  rows,
  myTeamId,
  leagueId,
  cash,
  canTrade,
  allowTransferOnly,
}: {
  rows: MarketRow[];
  myTeamId: string | null;
  leagueId: string;
  cash: number;
  canTrade: boolean;
  allowTransferOnly: boolean;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('free');
  const [tier, setTier] = useState('all');
  const [sort, setSort] = useState<Sort>('price-desc');
  const [limit, setLimit] = useState(40);
  const [open, setOpen] = useState<string | null>(null);

  const [buyState, buy] = useActionState<ActionState, FormData>(buyAction, {});
  const [sellState, sell] = useActionState<ActionState, FormData>(sellAction, {});
  const notice = buyState.error ?? sellState.error ?? buyState.success ?? sellState.success;
  const isError = Boolean(buyState.error ?? sellState.error);

  const visible = useMemo(() => {
    const kept = rows.filter((row) => {
      if (tier !== 'all' && row.tier !== tier) return false;
      if (filter === 'free' && row.ownerId) return false;
      if (filter === 'owned' && !row.ownerId) return false;
      if (filter === 'mine' && row.ownerId !== myTeamId) return false;
      if (!matchesQuery(row, query)) return false;
      return true;
    });
    return kept.sort((a, b) => {
      if (sort === 'name') return a.label.localeCompare(b.label);
      return sort === 'price-asc' ? a.price - b.price : b.price - a.price;
    });
  }, [rows, query, filter, tier, sort, myTeamId]);

  const filters: { key: Filter; label: string }[] = [
    { key: 'free', label: 'Available' },
    { key: 'all', label: 'All' },
    { key: 'owned', label: 'Owned' },
    ...(myTeamId ? [{ key: 'mine' as const, label: 'Mine' }] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <p
          className={`rounded-lg border px-3 py-2 text-sm ${
            isError
              ? 'border-negative/40 bg-negative/10 text-negative'
              : 'border-positive/40 bg-positive/10 text-positive'
          }`}
        >
          {notice}
        </p>
      )}

      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setLimit(40);
        }}
        placeholder="Search by name, type or tier…"
        className={inputClass}
      />

      <div className="flex gap-1 overflow-x-auto pb-1">
        {filters.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setFilter(option.key)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              filter === option.key ? 'bg-accent text-accent-ink' : 'bg-panel-2 text-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
        <span className="mx-1 w-px shrink-0 bg-line" />
        {['all', ...TIER_ORDER].map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTier(option)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              tier === option ? 'bg-accent text-accent-ink' : 'bg-panel-2 text-muted hover:text-ink'
            }`}
          >
            {option === 'all' ? 'Any tier' : option}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {visible.length} shown · you have {money(cash)}
        </p>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs text-muted"
          aria-label="Sort the market"
        >
          <option value="price-desc">Price: high to low</option>
          <option value="price-asc">Price: low to high</option>
          <option value="name">Name (A–Z)</option>
        </select>
      </div>

      <ul className="flex flex-col">
        {visible.slice(0, limit).map((row) => {
          const isMine = Boolean(myTeamId) && row.ownerId === myTeamId;
          const isFree = !row.ownerId;
          const tooExpensive = row.price > cash;
          const isOpen = open === row.slug;

          return (
            <li key={row.slug} className="border-b border-line last:border-0">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : row.slug)}
                className={`flex w-full items-center gap-3 py-2.5 text-left transition ${
                  isOpen ? 'bg-accent/5' : 'hover:bg-panel-2'
                }`}
              >
                <PokemonIcon icon={row.iconUrl} alt="" size={36} />
                <TierBadge tier={row.tier} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{row.label}</span>
                    {row.megas.length > 0 && (
                      <span className="shrink-0 text-[10px] text-accent">
                        ★{row.megas.length > 1 ? ` ×${row.megas.length}` : ''}
                      </span>
                    )}
                    {!row.legal ? (
                      <span className="shrink-0 rounded bg-negative/15 px-1 text-[10px] text-negative">
                        delisted
                      </span>
                    ) : (
                      row.restricted && (
                        <span className="shrink-0 rounded bg-tier-d/20 px-1 text-[10px] whitespace-nowrap text-tier-d">
                          {row.notes ?? 'restricted'}
                        </span>
                      )
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <TypePills types={row.types} />
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular block text-sm font-semibold">
                    {moneyShort(isFree ? row.price : row.value)}
                  </span>
                  <span
                    className={`block max-w-[7rem] truncate text-xs ${
                      isMine ? 'text-accent' : 'text-muted'
                    }`}
                  >
                    {isMine ? 'yours' : (row.ownerName ?? 'available')}
                  </span>
                </span>
              </button>

              {isOpen && (
                <div className="flex flex-col gap-2 bg-panel-2 px-3 py-3">
                  <div className="tabular flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    <span>BST {row.bst}</span>
                    <span>{isFree ? `shop price ${money(row.price)}` : `worth ${money(row.value)}`}</span>
                    {isFree && <span>worth {money(buyValue(row.price))} once signed</span>}
                  </div>
                  {row.megas.length > 0 && (
                    <p className="text-xs text-accent">Comes with {row.megas.join(' and ')}.</p>
                  )}
                  {row.legal && row.restricted && (
                    <p className="text-xs text-tier-d">
                      {row.notes ?? 'Restricted'} — on the Champions roster, but you can&rsquo;t
                      catch one in game. You need to bring it in from another game to actually
                      battle with it.
                    </p>
                  )}

                  {!myTeamId ? (
                    <p className="text-xs text-muted">You don't have a team in this league.</p>
                  ) : isFree ? (
                    row.legal && (!row.restricted || allowTransferOnly) ? (
                      <form action={buy}>
                        <input type="hidden" name="leagueId" value={leagueId} />
                        <input type="hidden" name="pokemonSlug" value={row.slug} />
                        {tooExpensive && (
                          <p className="mb-2 text-xs text-negative">
                            You&rsquo;re {money(row.price - cash)} short.
                          </p>
                        )}
                        <p className="mb-2 text-xs text-muted">
                          Pay {money(row.price)} · worth {money(buyValue(row.price))} once signed (
                          {VALUE_RULES.buyKeepPct - 100}%).
                        </p>
                        <SubmitButton label={`Sign for ${money(row.price)}`} variant="primary" />
                      </form>
                    ) : (
                      <p className="text-xs text-negative">
                        {row.legal
                          ? "This league doesn't allow Pokémon you can't catch in game."
                          : "No longer on the Champions roster, so it can't be signed."}
                      </p>
                    )
                  ) : isMine ? (
                    <form action={sell}>
                      <input type="hidden" name="leagueId" value={leagueId} />
                      <input type="hidden" name="pokemonSlug" value={row.slug} />
                      <SubmitButton label={`Release for ${money(row.value)}`} variant="danger" />
                    </form>
                  ) : (
                    <p className="text-xs text-muted">
                      Owned by {row.ownerName}.{' '}
                      {canTrade && (
                        <a href={`/league/${leagueId}/trades`} className="text-accent hover:underline">
                          Offer a trade →
                        </a>
                      )}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {visible.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((current) => current + 100)}
          className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-muted hover:text-ink"
        >
          Show more ({visible.length - limit} left)
        </button>
      )}
    </div>
  );
}

/** "How value changes", written straight from the rules the server applies. */
export function ValueRules() {
  const tiers = ['poke', 'great', 'ultra', 'master'] as const;
  const names: Record<string, string> = {
    poke: 'Poké Ball',
    great: 'Great Ball',
    ultra: 'Ultra Ball',
    master: 'Master Ball',
  };

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">When you sign</div>
        <div className="mt-1 text-2xl font-bold text-negative">
          {VALUE_RULES.buyKeepPct - 100}%
        </div>
        <p className="mt-1 text-xs text-muted">
          You pay the shop price, but it is only worth {VALUE_RULES.buyKeepPct}% of it from then on.
          Sign and sell straight away and you lose the difference.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-3 sm:col-span-2">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">
          Per match, by ladder tier
        </div>
        <table className="tabular mt-2 w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="text-left font-medium">Tier</th>
              <th className="text-right font-medium">Win</th>
              <th className="text-right font-medium">Loss</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((key) => (
              <tr key={key}>
                <td className="py-0.5">{names[key]}</td>
                <td className="py-0.5 text-right text-positive">+{VALUE_RULES.perf[key].win}%</td>
                <td className="py-0.5 text-right text-negative">{VALUE_RULES.perf[key].loss}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-muted">
          Only Pokémon that were sent out move. Winning low barely pays; losing high barely costs.
        </p>
      </div>
    </div>
  );
}

/** What each tier costs, so the letters on the badges mean something. */
export function PriceBands() {
  return (
    <ul className="flex flex-wrap gap-2 text-xs text-muted">
      {TIERS.map((tier) => (
        <li key={tier} className="flex items-center gap-1.5">
          <TierBadge tier={tier} />
          <span className="tabular">
            {moneyShort(TIER_PRICE_BANDS[tier][0])}–{moneyShort(TIER_PRICE_BANDS[tier][1])}
          </span>
        </li>
      ))}
    </ul>
  );
}
