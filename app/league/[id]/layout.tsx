import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getSessionUser } from '../../../lib/auth/session.ts';
import { getLeagueContext } from '../../../lib/services/league.ts';

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const context = await getLeagueContext(id, user.id);
  if (!context) notFound();

  // Someone with the link but no team in this league has nothing to see.
  if (!context.myTeam && !context.isCommissioner) redirect('/');

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <Link href={`/league/${id}`} className="truncate text-lg font-bold hover:text-accent">
          {context.league.name}
        </Link>
        <Link href="/" className="shrink-0 text-xs text-muted hover:text-ink">
          All leagues
        </Link>
      </header>
      {children}
    </div>
  );
}
