'use server';

import { redirect } from 'next/navigation';

import { db } from '../../lib/db.ts';
import { hashPassword, validatePassword, verifyPassword } from '../../lib/auth/password.ts';
import { createSession, destroySession, pruneSessions } from '../../lib/auth/session.ts';

export interface FormState {
  error?: string;
}

const USERNAME_RULE = /^[a-zA-Z0-9_-]{3,24}$/;

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const username = String(formData.get('username') ?? '').trim();
  const displayName = String(formData.get('displayName') ?? '').trim() || username;
  const password = String(formData.get('password') ?? '');

  if (!USERNAME_RULE.test(username)) {
    return { error: 'Username must be 3–24 characters: letters, numbers, - or _.' };
  }
  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };

  const existing = await db.user.findUnique({ where: { username } });
  if (existing) return { error: 'That username is taken.' };

  const user = await db.user.create({
    data: { username, displayName, passwordHash: await hashPassword(password) },
  });

  await createSession(user.id);
  redirect('/');
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  const user = await db.user.findUnique({ where: { username } });

  // Same message either way, so this can't be used to enumerate who's in the league.
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) return { error: 'Wrong username or password.' };

  await pruneSessions();
  await createSession(user.id);
  redirect('/');
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/login');
}
