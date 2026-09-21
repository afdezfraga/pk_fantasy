import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSessionUser } from '../lib/auth/session.ts';
import { db } from '../lib/db.ts';
import { money } from '../lib/format.ts';
import { signOut } from './actions/auth.ts';
import { ClubCrest, crestOf } from './components/ClubCrest.tsx';
import { Button, Empty, Panel } from './components/ui.tsx';
import { LobbyForms } from './LobbyForms.tsx';

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const teams = await db.team.findMany({
    where: { userId: user.id },
    include: {
      league: { include: { _count: { select: { teams: true } } } },
      _count: { select: { ownerships: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const catalogSize = await db.pokemon.count({ where: { legal: true } });

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Champions Fantasy</h1>
          <p className="text-sm text-muted">Signed in as {user.displayName}</p>
        </div>
        <form action={signOut}>
          <Button variant="ghost" type="submit">
            Sign out
          </Button>
        </form>
      </header>

      <div className="flex flex-col gap-5">
        <Panel title="Your leagues">
          {teams.length === 0 ? (
            <Empty>No leagues yet. Start one below, or join with an invite code.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {teams.map((team) => (
                <li key={team.id}>
                  <Link
                    href={`/league/${team.leagueId}`}
                    className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-4 py-3 transition hover:border-accent/40"
                  >
                    <ClubCrest crest={crestOf(team)} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{team.league.name}</div>
                      <div className="truncate text-xs text-muted">
                        {team.name} · {team._count.ownerships} Pokémon ·{' '}
                        {team.league._count.teams} team{team.league._count.teams === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="tabular shrink-0 text-sm font-semibold text-accent">
                      {money(team.cash)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <LobbyForms />

        <p className="text-center text-xs text-muted">
          {catalogSize} Pokémon in the Champions catalog.
        </p>
      </div>
    </main>
  );
}
