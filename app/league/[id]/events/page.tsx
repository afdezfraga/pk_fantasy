import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { getBoard, recentResults, sweepBoard } from '../../../../lib/services/board.ts';
import { activeEffects } from '../../../../lib/services/effects.ts';
import {
  ensurePendingEvent,
  getTeamEvents,
  parseChoices,
  pendingEvent,
} from '../../../../lib/services/events.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { Constraints } from '../../../components/Constraints.tsx';
import { money } from '../../../../lib/format.ts';
import { Empty, NavTabs, Panel } from '../../../components/ui.tsx';
import { BoardCard } from './BoardCard.tsx';
import { BoardSettingsForm } from './BoardSettingsForm.tsx';
import { Deadline } from './Deadline.tsx';
import { EventCard } from './EventCard.tsx';

export const dynamic = 'force-dynamic';

/** Good news rather than a problem — the gold treatment, same as the league feed. */
function fortune(event: { detail: string }): boolean {
  try {
    return (JSON.parse(event.detail || '{}') as { tone?: string }).tone === 'fortune';
  } catch {
    return false;
  }
}

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();

  const { league, myTeam, isCommissioner, config } = context;

  // Both are lazy, so opening this page is one of the moments a board closes — and with it, an
  // event arrives for whoever won it — or an event the club caused comes due.
  const live = league.status === 'ACTIVE' && Boolean(config.eventsEnabled);
  if (live) await sweepBoard(id);
  if (myTeam && live) await ensurePendingEvent(id, myTeam.id);

  const pending = myTeam ? await pendingEvent(id, myTeam.id) : null;
  const history = myTeam ? await getTeamEvents(id, myTeam.id, 20) : [];
  const effects = myTeam ? await activeEffects(id, myTeam.id) : [];
  const board = live ? await getBoard(id, myTeam?.id ?? null) : [];
  const results = config.eventsEnabled ? await recentResults(id, 6) : [];
  const closesAt = board[0]?.closesAt ?? null;

  const past = history.filter((event) => event.id !== pending?.id);

  return (
    <div className="flex flex-col gap-5">
      <NavTabs
        leagueId={id}
        active="events"
        showDraft={Boolean(league.draft)}
        pendingEvent={Boolean(pending)}
      />

      {!config.eventsEnabled && (
        <Panel title="Events">
          <Empty>
            Events are switched off in this league. The commissioner can turn them back on by
            setting <code className="text-xs">eventsEnabled</code> in the league config.
          </Empty>
        </Panel>
      )}

      {pending && myTeam && (
        <Panel title="A decision is waiting">
          <p className="mb-3 text-xs text-muted">
            You can&rsquo;t report another match until this is answered. Every option here is
            something your club can actually do.
          </p>
          <EventCard
            leagueId={id}
            eventId={pending.id}
            title={pending.title}
            description={pending.description}
            fortune={JSON.parse(pending.detail || '{}').tone === 'fortune'}
            options={parseChoices(pending.choices).map((option) => ({
              key: option.key,
              label: option.label,
              detail: option.detail,
              cost: option.cost,
              available: option.available,
              unavailableReason: option.unavailableReason,
              default: option.default,
            }))}
          />
        </Panel>
      )}

      {live && (
        <Panel
          title="Event board"
          action={closesAt ? <Deadline at={closesAt.toISOString()} /> : undefined}
        >
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Say what you&rsquo;d want to be paid to take each one on. When the board closes the
            lowest bid gets the event and the money; a tie goes to the club lower down the table,
            and an event nobody bids on simply goes away. Bids are sealed and final, and nobody
            else&rsquo;s is ever shown. Each club sees its own version — if a Pokémon it names
            leaves your squad, it is written again for one who&rsquo;s still there.
          </p>
          {board.length === 0 ? (
            <Empty>Nothing on the board right now. The next one goes up when this one closes.</Empty>
          ) : (
            <div className="flex flex-col gap-3">
              {board.map((entry) => (
                <BoardCard
                  key={entry.id}
                  leagueId={id}
                  auctionId={entry.id}
                  title={entry.title}
                  description={entry.description}
                  announcement={entry.announcement}
                  closedReason={myTeam ? entry.closedReason : 'You have no club in this league.'}
                  myBid={entry.myBid}
                  bidMax={config.eventBidMax}
                  options={entry.options.map((option) => ({
                    key: option.key,
                    label: option.label,
                    detail: option.detail,
                    cost: option.cost,
                    available: option.available,
                    unavailableReason: option.unavailableReason,
                    default: option.default,
                  }))}
                />
              ))}
            </div>
          )}
        </Panel>
      )}

      {results.length > 0 && (
        <Panel title="Board results">
          <ul className="flex flex-col divide-y divide-line">
            {results.map((result) => (
              <li key={result.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{result.title}</span>
                  <span className="text-muted">
                    {result.winner
                      ? ` — ${result.winnerTeamId === myTeam?.id ? 'you' : result.winner}`
                      : ' — nobody bid'}
                  </span>
                </span>
                <span className="tabular shrink-0 text-xs text-muted">
                  {result.winner && result.amount !== null
                    ? `${money(result.amount)} · ${result.bids} ${result.bids === 1 ? 'bid' : 'bids'}`
                    : 'gone'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {isCommissioner && config.eventsEnabled && (
        <Panel title="Board settings">
          <p className="text-xs text-muted">
            Changes apply from the next board. The one on show keeps the close time and ceiling
            clubs have already bid against.
          </p>
          <BoardSettingsForm
            leagueId={id}
            values={{
              eventBoardHours: config.eventBoardHours,
              eventBoardSize: config.eventBoardSize,
              eventBidMax: config.eventBidMax,
            }}
          />
        </Panel>
      )}

      {effects.length > 0 && (
        <Panel title="What you're playing under">
          <Constraints
            constraints={effects.map((effect) => ({
              id: effect.id,
              kind: effect.kind,
              label: effect.label,
              attested: effect.attested,
              matchesLeft: effect.matchesLeft,
              eventsLeft: effect.eventsLeft,
            }))}
          />
        </Panel>
      )}

      <Panel title={pending ? 'Earlier' : 'Your events'}>
        {past.length === 0 ? (
          <Empty>
            Nothing has happened to your club yet. Events come from the board above, when you win
            one — or, every few matches, from something your club has done.
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {past.map((event) => {
              const choice = parseChoices(event.choices).find(
                (option) => option.key === event.choiceKey,
              );
              // A virtue never went PENDING, so it lands straight in here. It is the one row in
              // this list that is unambiguously good news, and it is shown the way it arrived.
              const lucky = fortune(event);
              return (
                <li
                  key={event.id}
                  className={`flex flex-col gap-1 py-3 first:pt-0 last:pb-0 ${
                    lucky ? 'fortune -mx-2 my-1 rounded-lg border px-3' : ''
                  }`}
                >
                  {lucky && (
                    <div className="text-[11px] font-semibold tracking-[0.14em] text-accent uppercase">
                      Your luck has turned
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={`text-sm font-semibold ${
                        event.status === 'NOTICE' ? 'text-positive' : 'text-ink'
                      }`}
                    >
                      {event.title}
                    </span>
                    <span className="tabular shrink-0 text-[11px] text-muted">
                      Round {event.round}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">{event.description}</p>
                  {choice && <p className="text-xs text-accent">You chose: {choice.label}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
