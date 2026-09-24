'use client';

/**
 * When the board closes, in the reader's own time zone.
 *
 * Rendered on the client because the server's clock is not the manager's: a board that closes
 * at 20:00 UTC closes at 21:00 in London and 22:00 in Madrid, and a deadline read in the wrong
 * zone is a bid placed an hour too late. The server's render is replaced on hydration.
 */
export function Deadline({ at }: { at: string }) {
  const when = new Date(at);
  return (
    <span className="text-xs text-muted" suppressHydrationWarning>
      closes{' '}
      {when.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </span>
  );
}
