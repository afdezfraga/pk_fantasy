import { redirect } from 'next/navigation';

import { getSessionUser } from '../../lib/auth/session.ts';
import { AuthForm } from './AuthForm.tsx';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; code?: string }>;
}) {
  if (await getSessionUser()) redirect('/');
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <h1 className="text-2xl font-bold">Champions Fantasy</h1>
        <p className="mt-1 text-sm text-muted">
          Run a Pokémon Champions league with your friends.
        </p>
      </header>

      <AuthForm initialMode={params.mode === 'signup' ? 'signup' : 'signin'} />

      <p className="text-center text-xs text-muted">
        Self-hosted. Your league's data stays on this machine.
      </p>
    </main>
  );
}
