/**
 * Serves a team's uploaded crest.
 *
 * Crests live in the database rather than on disk so that backing the league up stays "copy
 * dev.db" — see the README. They're small (256KB at the very most) and read rarely enough that
 * a round trip per crest is nothing next to the convenience.
 */

import { db } from '../../../../lib/db.ts';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { crestImage: true, crestMime: true, crestUpdatedAt: true },
  });
  if (!team?.crestImage || !team.crestMime) {
    return new Response('No crest', { status: 404 });
  }

  return new Response(new Uint8Array(team.crestImage), {
    headers: {
      'Content-Type': team.crestMime,
      // The URL carries the upload time, so a given URL never changes.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(team.crestImage.length),
    },
  });
}
