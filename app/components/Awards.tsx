/** The honours board: one line per award a club has actually won. */

import type { Award } from '../../lib/services/stats.ts';
import { Empty } from './ui.tsx';

export function Awards({ awards }: { awards: Award[] }) {
  if (awards.length === 0) {
    return <Empty>Nothing to hand out yet — play a few matches.</Empty>;
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {awards.map((award) => (
        <li
          key={award.key}
          className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2"
        >
          <span className="text-xl" aria-hidden="true">
            {award.emoji}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] tracking-wide text-muted uppercase">
              {award.title}
            </span>
            <span className="block truncate text-sm font-semibold">{award.name}</span>
          </span>
          <span className="tabular shrink-0 text-sm font-bold text-accent">{award.value}</span>
        </li>
      ))}
    </ul>
  );
}
