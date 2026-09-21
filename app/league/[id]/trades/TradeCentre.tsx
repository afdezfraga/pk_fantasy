'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { money } from '../../../../lib/format.ts';
import {
  proposeTradeAction,
  respondTradeAction,
  type ActionState,
} from '../../../actions/market.ts';
import { PokemonIcon } from '../../../components/PokemonImage.tsx';
import { Button, Empty, Field, Panel, TierBadge, inputClass } from '../../../components/ui.tsx';

interface Entry {
  slug: string;
  label: string;
  tier: string;
  value: number;
  iconUrl: string | null;
}

export interface Offer {
  id: string;
  fromTeamId: string;
  fromName: string;
  toName: string;
  cash: number;
  status: string;
  note: string | null;
  give: string[];
  get: string[];
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Sending…' : label}
    </Button>
  );
}

function PickList({
  name,
  roster,
  selected,
  toggle,
  emptyText,
}: {
  name: string;
  roster: Entry[];
  selected: string[];
  toggle: (slug: string) => void;
  emptyText: string;
}) {
  if (roster.length === 0) return <p className="py-2 text-xs text-muted">{emptyText}</p>;

  return (
    <ul className="max-h-48 overflow-y-auto">
      {roster.map((entry) => {
        const checked = selected.includes(entry.slug);
        return (
          <li key={entry.slug}>
            <label className="flex cursor-pointer items-center gap-2 border-b border-line py-2 last:border-0">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(entry.slug)}
                className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              />
              <PokemonIcon icon={entry.iconUrl} alt="" size={28} />
              <TierBadge tier={entry.tier} />
              <span className="min-w-0 flex-1 truncate text-sm">{entry.label}</span>
              <span className="tabular shrink-0 text-xs text-muted">{money(entry.value)}</span>
              {checked && <input type="hidden" name={name} value={entry.slug} />}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function TradeCentre({
  leagueId,
  myTeamId,
  myCash,
  teams,
  rosterByTeam,
  labels,
  offers,
}: {
  leagueId: string;
  myTeamId: string;
  myCash: number;
  teams: { id: string; name: string }[];
  rosterByTeam: Record<string, Entry[]>;
  labels: Record<string, string>;
  offers: Offer[];
}) {
  const others = teams.filter((team) => team.id !== myTeamId);
  const [partner, setPartner] = useState(others[0]?.id ?? '');
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [cash, setCash] = useState(0);

  const [proposeState, propose] = useActionState<ActionState, FormData>(proposeTradeAction, {});
  const [respondState, respond] = useActionState<ActionState, FormData>(respondTradeAction, {});

  const toggle = (list: string[], set: (next: string[]) => void) => (slug: string) =>
    set(list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]);

  const mine = rosterByTeam[myTeamId] ?? [];
  const theirs = rosterByTeam[partner] ?? [];
  const giveValue = mine.filter((e) => give.includes(e.slug)).reduce((s, e) => s + e.value, 0);
  const getValue = theirs.filter((e) => get.includes(e.slug)).reduce((s, e) => s + e.value, 0);

  const pending = offers.filter((offer) => offer.status === 'PENDING');
  const settled = offers.filter((offer) => offer.status !== 'PENDING');

  if (others.length === 0) {
    return (
      <Panel title="Trades">
        <Empty>There's nobody else in the league yet.</Empty>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Propose a trade">
        <form key={proposeState.success} action={propose} className="flex flex-col gap-4">
          <input type="hidden" name="leagueId" value={leagueId} />
          <input type="hidden" name="toTeamId" value={partner} />

          <Field label="Trade with">
            <select
              value={partner}
              onChange={(event) => {
                setPartner(event.target.value);
                setGet([]);
              }}
              className={inputClass}
            >
              {others.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </Field>

          <div>
            <span className="mb-1 block text-sm font-medium">You give</span>
            <div className="rounded-lg border border-line bg-panel-2 px-3">
              <PickList
                name="give"
                roster={mine}
                selected={give}
                toggle={toggle(give, setGive)}
                emptyText="You have no Pokémon to offer."
              />
            </div>
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium">You get</span>
            <div className="rounded-lg border border-line bg-panel-2 px-3">
              <PickList
                name="get"
                roster={theirs}
                selected={get}
                toggle={toggle(get, setGet)}
                emptyText="They have no Pokémon yet."
              />
            </div>
          </div>

          <Field
            label="Cash you add"
            hint={`Negative asks them for cash instead. You have ${money(myCash)}.`}
          >
            <input
              name="cash"
              type="number"
              step={500}
              value={cash}
              onChange={(event) => setCash(Number.parseInt(event.target.value, 10) || 0)}
              className={inputClass}
            />
          </Field>

          <div className="tabular rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
            You give {money(giveValue + Math.max(cash, 0))} · you get{' '}
            {money(getValue + Math.max(-cash, 0))}
          </div>

          <Field label="Note" hint="Optional.">
            <input name="note" className={inputClass} placeholder="Need a Fire type, you need speed" />
          </Field>

          {proposeState.error && <p className="text-sm text-negative">{proposeState.error}</p>}
          {proposeState.success && <p className="text-sm text-positive">{proposeState.success}</p>}

          <Submit label="Send offer" />
        </form>
      </Panel>

      <Panel title={`Offers${pending.length ? ` · ${pending.length} pending` : ''}`}>
        {respondState.error && <p className="mb-2 text-sm text-negative">{respondState.error}</p>}
        {respondState.success && <p className="mb-2 text-sm text-positive">{respondState.success}</p>}

        {offers.length === 0 ? (
          <Empty>No offers yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {[...pending, ...settled].map((offer) => {
              const incoming = offer.fromTeamId !== myTeamId;
              return (
                <li key={offer.id} className="rounded-lg border border-line bg-panel-2 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                      {incoming ? `From ${offer.fromName}` : `To ${offer.toName}`}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        offer.status === 'PENDING'
                          ? 'bg-accent/15 text-accent'
                          : offer.status === 'ACCEPTED'
                            ? 'bg-positive/15 text-positive'
                            : 'bg-line text-muted'
                      }`}
                    >
                      {offer.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="mb-1 text-muted">{incoming ? 'They give' : 'You give'}</div>
                      {offer.give.map((slug) => (
                        <div key={slug} className="truncate">
                          {labels[slug] ?? slug}
                        </div>
                      ))}
                      {offer.cash > 0 && <div className="text-positive">{money(offer.cash)}</div>}
                      {offer.give.length === 0 && offer.cash <= 0 && (
                        <div className="text-muted">—</div>
                      )}
                    </div>
                    <div>
                      <div className="mb-1 text-muted">{incoming ? 'You give' : 'They give'}</div>
                      {offer.get.map((slug) => (
                        <div key={slug} className="truncate">
                          {labels[slug] ?? slug}
                        </div>
                      ))}
                      {offer.cash < 0 && <div className="text-positive">{money(-offer.cash)}</div>}
                      {offer.get.length === 0 && offer.cash >= 0 && <div className="text-muted">—</div>}
                    </div>
                  </div>

                  {offer.note && <p className="mt-2 text-xs italic text-muted">"{offer.note}"</p>}

                  {offer.status === 'PENDING' && (
                    <div className="mt-3 flex gap-2">
                      {incoming && (
                        <form action={respond} className="flex-1">
                          <input type="hidden" name="leagueId" value={leagueId} />
                          <input type="hidden" name="offerId" value={offer.id} />
                          <input type="hidden" name="accept" value="1" />
                          <Button type="submit" className="w-full px-2 py-1.5 text-xs">
                            Accept
                          </Button>
                        </form>
                      )}
                      <form action={respond} className="flex-1">
                        <input type="hidden" name="leagueId" value={leagueId} />
                        <input type="hidden" name="offerId" value={offer.id} />
                        <input type="hidden" name="accept" value="0" />
                        <Button
                          type="submit"
                          variant="ghost"
                          className="w-full px-2 py-1.5 text-xs"
                        >
                          {incoming ? 'Decline' : 'Cancel'}
                        </Button>
                      </form>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
