'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { valuePerf } from '../../../../config/economy.ts';
import { SCORING, scoreTeam, streakMultiplier } from '../../../../config/scoring.ts';
import { money } from '../../../../lib/format.ts';
import { deriveScore } from '../../../../lib/match.ts';
import { reportMatchAction, type ActionState } from '../../../actions/market.ts';
import { PokemonArt } from '../../../components/PokemonImage.tsx';
import { Button, Field, TierBadge, inputClass } from '../../../components/ui.tsx';

export interface Starter {
  slug: string;
  label: string;
  tier: string;
  iconUrl: string | null;
  homeUrl: string | null;
}

interface Line {
  kos: number;
  fainted: boolean;
}

const EMPTY: Line = { kos: 0, fainted: false };

/** Points a line is worth, mirrored from config/scoring.ts so the form can show it live. */
function linePoints(line: Line): number {
  return line.kos * SCORING.koLanded + (line.fainted ? SCORING.fainted : SCORING.survived);
}

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} className="w-full">
      {pending ? 'Saving…' : 'Record result'}
    </Button>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
        className="h-8 w-8 rounded-md border border-line bg-panel text-lg leading-none text-muted disabled:opacity-30"
        aria-label="One fewer KO"
      >
        −
      </button>
      <span className="tabular w-5 text-center text-sm font-semibold">{value}</span>
      <button
        type="button"
        disabled={value >= 6}
        onClick={() => onChange(value + 1)}
        className="h-8 w-8 rounded-md border border-line bg-panel text-lg leading-none text-muted disabled:opacity-30"
        aria-label="One more KO"
      >
        +
      </button>
    </span>
  );
}

export function ReportForm({
  leagueId,
  myTeamId,
  starters,
  round,
  paidThisRound,
  payCap,
  bringToMatch,
  tierKey,
  tierName,
  streak,
}: {
  leagueId: string;
  myTeamId: string;
  starters: Starter[];
  round: number;
  paidThisRound: number;
  payCap: number;
  bringToMatch: number;
  /** The team's ladder tier: it sets both the reward and the value moves. */
  tierKey: string;
  tierName: string;
  /** Wins in a row going into this match. */
  streak: number;
}) {
  const [won, setWon] = useState(true);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [state, action] = useActionState<ActionState, FormData>(reportMatchAction, {});

  const brought = Object.keys(lines);
  const full = brought.length >= bringToMatch;

  const toggle = (slug: string) => {
    const next = { ...lines };
    if (slug in next) delete next[slug];
    else if (!full) next[slug] = EMPTY;
    setLines(next);
  };

  const update = (slug: string, patch: Partial<Line>) =>
    setLines({ ...lines, [slug]: { ...(lines[slug] ?? EMPTY), ...patch } });

  const entered = Object.values(lines);
  const score = deriveScore({ won, lines: entered });

  // The same calculation the server runs, so what's on screen is the money that lands.
  const nextStreak = won ? streak + 1 : 0;
  const preview = scoreTeam({
    lines: entered.map((line) => ({ pokemonSlug: '', ...line, benched: false })),
    won,
    underdog: false,
    streak: nextStreak,
    tierKey,
  });
  const multiplier = streakMultiplier(nextStreak);
  const pct = valuePerf(tierKey, won);
  const willPay = paidThisRound < payCap;

  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
          Report a ladder match
        </h2>
        <span className="text-xs text-muted">
          {tierName} · {Math.max(0, payCap - paidThisRound)} of {payCap} paid left in round {round}
        </span>
      </header>

      <form key={state.success} action={action} className="flex flex-col gap-4 p-4">
        <input type="hidden" name="leagueId" value={leagueId} />
        <input type="hidden" name="homeTeamId" value={myTeamId} />
        <input type="hidden" name="won" value={won ? '1' : '0'} />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setWon(true)}
            aria-pressed={won}
            className={`rounded-lg border py-3 text-sm font-bold uppercase tracking-wide transition ${
              won
                ? 'border-positive/60 bg-positive/15 text-positive'
                : 'border-line bg-panel-2 text-muted hover:text-ink'
            }`}
          >
            Won
          </button>
          <button
            type="button"
            onClick={() => setWon(false)}
            aria-pressed={!won}
            className={`rounded-lg border py-3 text-sm font-bold uppercase tracking-wide transition ${
              !won
                ? 'border-negative/60 bg-negative/15 text-negative'
                : 'border-line bg-panel-2 text-muted hover:text-ink'
            }`}
          >
            Lost
          </button>
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm font-medium">Who did you bring?</span>
            <span className={`text-xs ${full ? 'text-accent' : 'text-muted'}`}>
              {brought.length} of {bringToMatch}
              {full && ' — tap one to swap'}
            </span>
          </div>

          {starters.length === 0 ? (
            <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
              You have nobody in your starting lineup. Set it on the Club page first.
            </p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-line bg-panel-2">
              {starters.map((entry) => {
                const line = lines[entry.slug];
                const selected = line !== undefined;
                const dimmed = full && !selected;

                return (
                  <li key={entry.slug} className="border-b border-line last:border-0">
                    <button
                      type="button"
                      onClick={() => toggle(entry.slug)}
                      disabled={dimmed}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition ${
                        selected ? 'bg-accent/10' : dimmed ? 'opacity-40' : 'hover:bg-line/40'
                      }`}
                    >
                      <PokemonArt home={entry.homeUrl} icon={entry.iconUrl} alt="" size={44} />
                      <TierBadge tier={entry.tier} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {entry.label}
                      </span>
                      {selected ? (
                        <span
                          className={`tabular shrink-0 text-xs font-semibold ${
                            linePoints(line) > 0
                              ? 'text-positive'
                              : linePoints(line) < 0
                                ? 'text-negative'
                                : 'text-muted'
                          }`}
                        >
                          {linePoints(line) > 0 ? '+' : ''}
                          {linePoints(line)}
                        </span>
                      ) : (
                        // No "tap" prompt on a row that can't be tapped — the lineup is full.
                        !dimmed && <span className="shrink-0 text-xs text-muted">tap</span>
                      )}
                    </button>

                    {selected && (
                      <div className="flex flex-wrap items-center gap-4 px-3 pb-3 pl-[4.25rem]">
                        <span className="flex items-center gap-2">
                          <span className="text-xs text-muted">KOs</span>
                          <Stepper
                            value={line.kos}
                            onChange={(kos) => update(entry.slug, { kos })}
                          />
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-muted">
                          <input
                            type="checkbox"
                            checked={line.fainted}
                            onChange={(event) =>
                              update(entry.slug, { fainted: event.target.checked })
                            }
                            className="h-4 w-4 accent-[var(--color-negative)]"
                          />
                          Fainted
                        </label>
                        <input
                          type="hidden"
                          name={`line:${myTeamId}:${entry.slug}`}
                          value={`${line.kos},${line.fainted ? 1 : 0},0`}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="mt-2 text-xs text-muted">
            KOs earn +{SCORING.koLanded}, surviving +{SCORING.survived}, fainting {SCORING.fainted}.
            Points decide the awards; everyone you send out moves {pct > 0 ? '+' : ''}
            {pct}% in value for a {won ? 'win' : 'loss'} in {tierName}.
          </p>
        </div>

        {brought.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-line bg-panel-2 px-3 py-2">
            <span className="tabular text-sm font-semibold">
              {score.homeScore}–{score.awayScore}
            </span>
            <span className="flex items-center gap-3 text-xs">
              <span
                className={`tabular font-semibold ${
                  preview.totalPoints >= 0 ? 'text-positive' : 'text-negative'
                }`}
              >
                {preview.totalPoints > 0 ? '+' : ''}
                {preview.totalPoints} pts
              </span>
              <span
                className={`tabular ${willPay ? 'font-semibold text-accent' : 'text-muted line-through'}`}
              >
                {money(preview.money)}
                {won && multiplier > 1 && (
                  <span className="ml-1 font-semibold text-positive">
                    ×{multiplier} streak
                  </span>
                )}
              </span>
            </span>
          </div>
        )}

        {!willPay && (
          <p className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
            You&rsquo;ve hit this round&rsquo;s payout cap of {payCap}. Log the match anyway — it
            still counts toward your Pokémon&rsquo;s form, it just won&rsquo;t pay.
          </p>
        )}

        <Field label="Note" hint="Optional — anything worth remembering about the match.">
          <input name="note" className={inputClass} placeholder="Came back from 0–2 down" />
        </Field>

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

        <Submit disabled={brought.length === 0} />
      </form>
    </section>
  );
}
