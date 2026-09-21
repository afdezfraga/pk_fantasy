/**
 * Session handling: an opaque random token in an httpOnly cookie, checked against the database.
 *
 * No JWT — a database session can be revoked, and a self-hosted league has no scale problem
 * that a stateless token would solve.
 */

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';

import { db } from '../db.ts';

const COOKIE_NAME = 'pkf_session';
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await db.session.create({ data: { token, userId, expiresAt } });

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Allows plain HTTP on a LAN box; a public deployment should terminate TLS in front.
    secure: process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_COOKIE !== '1',
    path: '/',
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) await db.session.deleteMany({ where: { token } });
  store.delete(COOKIE_NAME);
}

/** The signed-in user, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { token },
    include: { user: { select: { id: true, username: true, displayName: true } } },
  });
  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  return session.user;
}

/** The signed-in user, or throws. For server actions that must not run anonymously. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error('You need to be signed in to do that.');
  return user;
}

/** Removes expired sessions. Cheap enough to call opportunistically at login. */
export async function pruneSessions(): Promise<void> {
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
