'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { makePickAction, passPickAction, type FormState } from '../../../actions/league.ts';
import { PokemonArt, PokemonIcon } from '../../../components/PokemonImage.tsx';
import { Button, ErrorNote, TierBadge, TypePills, inputClass } from '../../../components/ui.tsx';
import { money, moneyShort } from '../../../../lib/format.ts';

export interface DraftablePokemon {
  slug: string;
  label: string;
  tier: string;
  types: string[];
  value: number;
  bst: number;
  megas: string[];
  iconUrl: string | null;
  homeUrl: string | null;
}

const TIER_ORDER = ['S', 'A+', 'A', 'B', 'C', 'D', 'UR'];

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


export function DraftBoard({
  leagueId,
  teamId,
  isMyTurn,
  cash,
  pokemon,
}: {
  leagueId: string;
  teamId: string;
  isMyTurn: boolean;
  cash: number;
  pokemon: DraftablePokemon[];
}) {
  const router = useRouter();
  const [state, action] = useActionState<FormState, FormData>(makePickAction, {});
  const [passState, pass] = useActionState<FormState, FormData>(passPickAction, {});
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [affordableOnly, setAffordableOnly] = useState(false);
  const [cheapFirst, setCheapFirst] = useState(false);
  const [limit, setLimit] = useState(60);

  // While it isn't your turn, the interesting thing is other people's picks landing.
  useEffect(() => {
    if (isMyTurn) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [isMyTurn, router]);

  const canAfford = (entry: DraftablePokemon) =>
    entry.value <= cash;

  const matching = useMemo(() => {
    const rows = pokemon
      .filter((entry) => (tier === 'all' ? true : entry.tier === tier))
      .filter((entry) => matchesQuery(entry, query))
      .filter((entry) => (affordableOnly ? canAfford(entry) : true));
    // The list arrives most-expensive first, which is useless once your budget is nearly gone.
    return cheapFirst ? [...rows].sort((a, b) => a.value - b.value) : rows;
  }, [pokemon, query, tier, affordableOnly, cheapFirst, cash]);

  const visible = matching.slice(0, limit);

  const chosen = pokemon.find((entry) => entry.slug === selected) ?? null;
  const affordable = chosen ? chosen.value <= cash : true;
  // Spent up to the cap? Then nothing on the board is signable and the turn has to be passable,
  // or the draft would stall here forever.
  const canAffordAnything = pokemon.some(
    (entry) => entry.value <= cash,
  );

  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            {isMyTurn ? 'Make your pick' : 'Available'}
          </h2>
          <div className="tabular text-xs text-muted">
            {money(cash)} to spend
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-2 border-b border-line p-3">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(60);
          }}
          placeholder={`Search ${pokemon.length} by name, type or tier…`}
          className={inputClass}
        />
        <div className="flex gap-1 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setAffordableOnly(!affordableOnly)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              affordableOnly ? 'bg-accent text-accent-ink' : 'bg-panel-2 text-muted hover:text-ink'
            }`}
          >
            Can afford
          </button>
          <button
            type="button"
            onClick={() => setCheapFirst(!cheapFirst)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
              cheapFirst ? 'bg-accent text-accent-ink' : 'bg-panel-2 text-muted hover:text-ink'
            }`}
          >
            {cheapFirst ? 'Cheapest first' : 'Priciest first'}
          </button>
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
              {option === 'all' ? 'All' : option}
            </button>
          ))}
        </div>
      </div>

      {isMyTurn && !canAffordAnything && (
        <div className="border-b border-line bg-negative/10 p-3">
          <p className="mb-2 text-xs text-negative">
            You can't afford anything left on the board. Pass your turn and finish
            with a smaller squad, or release someone from the Market first.
          </p>
          <form action={pass}>
            <input type="hidden" name="leagueId" value={leagueId} />
            <input type="hidden" name="teamId" value={teamId} />
            <Button type="submit" variant="ghost" className="w-full">
              Pass this pick
            </Button>
          </form>
          <ErrorNote>{passState.error}</ErrorNote>
        </div>
      )}

      <ul className="max-h-[26rem] overflow-y-auto">
        {visible.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted">Nothing matches that.</li>
        )}
        {visible.map((entry) => {
          const isSelected = entry.slug === selected;
          const tooExpensive = entry.value > cash;
          return (
            <li key={entry.slug}>
              <button
                type="button"
                onClick={() => setSelected(isSelected ? null : entry.slug)}
                className={`flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition ${
                  isSelected ? 'bg-accent/10' : 'hover:bg-panel-2'
                }`}
              >
                <PokemonIcon icon={entry.iconUrl} alt="" size={36} />
                <TierBadge tier={entry.tier} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{entry.label}</span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <TypePills types={entry.types} />
                    {entry.megas.length > 0 && (
                      <span className="shrink-0 text-[10px] text-accent">
                        ★{entry.megas.length > 1 ? ` ×${entry.megas.length}` : ''}
                      </span>
                    )}
                  </span>
                </span>
                <span
                  className={`tabular shrink-0 text-sm font-semibold ${
                    tooExpensive ? 'text-negative' : 'text-ink'
                  }`}
                >
                  {moneyShort(entry.value)}
                </span>
              </button>
            </li>
          );
        })}
        {matching.length > visible.length && (
          <li className="p-2">
            <button
              type="button"
              onClick={() => setLimit((current) => current + 120)}
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm font-medium text-muted hover:text-ink"
            >
              Show more ({matching.length - visible.length} left)
            </button>
          </li>
        )}
      </ul>

      {chosen && (
        <form action={action} className="flex flex-col gap-2 border-t border-line bg-panel-2 p-4">
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="teamId" value={teamId} />
          <input type="hidden" name="pokemonSlug" value={chosen.slug} />

          <div className="flex items-center justify-between gap-3">
            <PokemonArt home={chosen.homeUrl} icon={chosen.iconUrl} alt="" size={56} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{chosen.label}</div>
              <div className="tabular text-xs text-muted">
                {money(chosen.value)} · BST {chosen.bst}
              </div>
            </div>
            <TierBadge tier={chosen.tier} />
          </div>

          {chosen.megas.length > 0 && (
            <p className="text-xs text-accent">Comes with {chosen.megas.join(' and ')}.</p>
          )}

          <ErrorNote>{state.error}</ErrorNote>

          {!affordable && (
            <p className="text-xs text-negative">
              You&rsquo;re {money(chosen.value - cash)} short.
            </p>
          )}

          <PickButton disabled={!isMyTurn || !affordable} isMyTurn={isMyTurn} />
        </form>
      )}
    </section>
  );
}

function PickButton({ disabled, isMyTurn }: { disabled: boolean; isMyTurn: boolean }) {
  return (
    <Button type="submit" disabled={disabled} className="w-full">
      {isMyTurn ? 'Draft this Pokémon' : 'Waiting for your turn'}
    </Button>
  );
}
