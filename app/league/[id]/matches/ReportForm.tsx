'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { valuePerf } from '../../../../config/economy.ts';
import { SCORING, scoreTeam, streakMultiplier } from '../../../../config/scoring.ts';
import { money } from '../../../../lib/format.ts';
import { deriveScore } from '../../../../lib/match.ts';
import { reportMatchAction, type ActionState } from '../../../actions/market.ts';
import { Constraints, type ConstraintView } from '../../../components/Constraints.tsx';
import { PokemonArt } from '../../../components/PokemonImage.tsx';
import { Button, Field, TierBadge, inputClass } from '../../../components/ui.tsx';

export interface Starter {
  slug: string;
  label: string;
  tier: string;
  iconUrl: string | null;
  homeUrl: string | null;
  /** Why an event says this one can't play, if it does. */
  barredBy?: string;
}

export interface Attestation {
  id: string;
  label: string;
}

interface Line {
  kos: number;
  fainted: boolean;
  /** Brought to the match but never sent out. */
  benched: boolean;
}

const EMPTY: Line = { kos: 0, fainted: false, benched: false };

/** Points a line is worth, mirrored from config/scoring.ts so the form can show it live. */
function linePoints(line: Line): number {
  if (line.benched) return SCORING.benched;
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
  constraints = [],
  attestations = [],
  banEnforced = true,
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
  /** Everything in force, shown above the picker so nothing is a surprise. */
  constraints?: ConstraintView[];
  /** The honour-based ones, which the app can't check and so has to ask about. */
  attestations?: Attestation[];
  /**
   * False once the club is down to the bare minimum — a ban must never leave anyone unable to
   * field a match, so below that line a barred Pokémon may be taken, benched.
   */
  banEnforced?: boolean;
}) {
  const [won, setWon] = useState(true);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [state, action] = useActionState<ActionState, FormData>(reportMatchAction, {});

  const brought = Object.keys(lines);
  const full = brought.length >= bringToMatch;
  const allTicked = attestations.every((entry) => ticked[entry.id]);

  // Bringing a barred Pokémon is only possible at all when the club has no legal four without
  // it — and then it has to stay benched, because sending it out forfeits the match.
  const barredAndPlaying = brought.some(
    (slug) => starters.find((entry) => entry.slug === slug)?.barredBy && !lines[slug].benched,
  );

  const toggle = (slug: string) => {
    const next = { ...lines };
    if (slug in next) delete next[slug];
    else if (!full) {
      const barred = Boolean(starters.find((entry) => entry.slug === slug)?.barredBy);
      next[slug] = barred ? { ...EMPTY, benched: true } : EMPTY;
    }
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

        {/* First thing on the form, because a restriction you don't see is one you'll break. */}
        <Constraints constraints={constraints} title="Constraints in force" />

        {attestations.length > 0 && (
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
            <p className="mb-2 text-xs text-muted">
              These aren&rsquo;t things the app can check. Confirm how you actually played — the
              answers go in the league feed next to your result.
            </p>
            <div className="flex flex-col gap-2">
              {attestations.map((entry) => (
                <label key={entry.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="attested"
                    value={entry.id}
                    checked={Boolean(ticked[entry.id])}
                    onChange={(event) =>
                      setTicked({ ...ticked, [entry.id]: event.target.checked })
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                  />
                  <span className="text-ink">{entry.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}

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
                // A barred Pokémon is unpickable while the club has cover, and merely marked
                // while it doesn't — it stays on the board either way, because it's still yours.
                const barred = Boolean(entry.barredBy);
                const locked = barred && banEnforced;
                const dimmed = (full && !selected) || locked;

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
                        {barred && (
                          <span className="block truncate text-[11px] font-normal text-negative">
                            {entry.barredBy}
                            {!banEnforced && ' — bench only'}
                          </span>
                        )}
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
                        <label className="flex items-center gap-1.5 text-xs text-muted">
                          <input
                            type="checkbox"
                            checked={line.benched}
                            onChange={(event) =>
                              update(entry.slug, { benched: event.target.checked })
                            }
                            className="h-4 w-4 accent-[var(--color-accent)]"
                          />
                          Never sent out
                        </label>
                        <input
                          type="hidden"
                          name={`line:${myTeamId}:${entry.slug}`}
                          value={`${line.kos},${line.fainted ? 1 : 0},${line.benched ? 1 : 0}`}
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

        {barredAndPlaying && (
          <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
            You&rsquo;ve sent out a Pokémon that isn&rsquo;t allowed to play. That&rsquo;s a
            forfeit — this will be recorded as a loss whatever you tap above. Mark it{' '}
            <strong>never sent out</strong> to bring it as cover instead.
          </p>
        )}

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

        <Submit disabled={brought.length === 0 || !allTicked} />
      </form>
    </section>
  );
}
