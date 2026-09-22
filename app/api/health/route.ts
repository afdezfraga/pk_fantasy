/**
 * Liveness probe for the container healthcheck.
 *
 * Deliberately touches the database: a server that is up but can't reach `league.db` is not
 * healthy, and the point of the check is to restart that rather than serve errors all evening.
 */

import { db } from '../../../lib/db.ts';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
