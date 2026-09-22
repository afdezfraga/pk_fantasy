import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../../lib/auth/session.ts';
import { activeEffects } from '../../../../lib/services/effects.ts';
import {
  ensurePendingEvent,
  getTeamEvents,
  parseChoices,
  pendingEvent,
} from '../../../../lib/services/events.ts';
import { getLeagueContext } from '../../../../lib/services/league.ts';
import { Constraints } from '../../../components/Constraints.tsx';
import { Empty, NavTabs, Panel } from '../../../components/ui.tsx';
import { EventCard } from './EventCard.tsx';

export const dynamic = 'force-dynamic';

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();

  const { league, myTeam, isCommissioner, config } = context;

  // The draw is lazy, so opening this page is one of the moments an event can arrive.
  if (myTeam && league.status === 'ACTIVE' && config.eventsEnabled) {
    await ensurePendingEvent(id, myTeam.id);
  }

  const pending = myTeam ? await pendingEvent(id, myTeam.id) : null;
  const history = myTeam ? await getTeamEvents(id, myTeam.id, 20) : [];
  const effects = myTeam ? await activeEffects(id, myTeam.id) : [];

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
            delegable={(JSON.parse(pending.detail || '{}').delegable ?? true) as boolean}
            isCommissioner={isCommissioner}
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

      {effects.length > 0 && (
        <Panel title="What you're playing under">
          <Constraints
            constraints={effects.map((effect) => ({
              id: effect.id,
              kind: effect.kind,
              label: effect.label,
              attested: effect.attested,
              matchesLeft: effect.matchesLeft,
            }))}
          />
        </Panel>
      )}

      <Panel title={pending ? 'Earlier' : 'Your events'}>
        {past.length === 0 ? (
          <Empty>
            Nothing has happened to your club yet. Events arrive every few matches — and one lands
            the moment the draft ends.
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {past.map((event) => {
              const choice = parseChoices(event.choices).find(
                (option) => option.key === event.choiceKey,
              );
              return (
                <li key={event.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
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
                  {choice && (
                    <p className="text-xs text-accent">
                      You chose: {choice.label}
                      {event.status === 'DELEGATED' && ' (your assistant decided)'}
                      {event.status === 'FORCED' && ' (forced through by the commissioner)'}
                    </p>
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
