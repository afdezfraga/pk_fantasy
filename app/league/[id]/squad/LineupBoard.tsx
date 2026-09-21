'use client';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useRef, useState, useTransition } from 'react';

import { PlayerCard, type PlayerCardData } from '../../../components/PlayerCard.tsx';
import { Empty } from '../../../components/ui.tsx';
import { saveLineupAction, setCaptainAction } from '../../../actions/market.ts';

/**
 * The squad board: drag a card to pick your starting six and the order they line up in.
 *
 * Dragging is the fast way and tapping is the reliable one — every card also carries a button
 * that does the same thing, because a drag is hard work on a phone and impossible to explain in
 * a screenshot. dnd-kit's keyboard sensor covers the third case.
 *
 * The board owns its arrangement while you rearrange it and posts the whole thing at once. If
 * the server refuses (someone signed a Pokémon in another tab), it snaps back to what the server
 * last told us and says why.
 */

interface Zones {
  starters: string[];
  reserves: string[];
}

/** A drop target for a whole zone, so a card can be dropped onto empty space in it. */
function Zone({ id, children }: { id: keyof Zones; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`rounded-lg p-1 transition ${isOver ? 'bg-accent/5' : ''}`}>
      {children}
    </div>
  );
}

function SortableCard({
  entry,
  disabled,
  children,
}: {
  entry: PlayerCardData;
  disabled: boolean;
  children?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.slug,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`touch-none ${isDragging ? 'z-10 opacity-80' : ''}`}
      {...attributes}
      {...listeners}
    >
      <PlayerCard entry={entry} size={entry.starter ? 'full' : 'compact'}>
        {children}
      </PlayerCard>
    </div>
  );
}

export function LineupBoard({
  leagueId,
  squad,
  lineupSize,
  bringToMatch,
}: {
  leagueId: string;
  squad: PlayerCardData[];
  lineupSize: number;
  bringToMatch: number;
}) {
  const bySlug = new Map(squad.map((entry) => [entry.slug, entry]));
  const fromServer: Zones = {
    starters: squad.filter((entry) => entry.starter).map((entry) => entry.slug),
    reserves: squad.filter((entry) => !entry.starter).map((entry) => entry.slug),
  };

  const [zones, setZones] = useState<Zones>(fromServer);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync when the server sends a different squad — a signing, a sale, or a rejected save.
  const signature = [...fromServer.starters, '|', ...fromServer.reserves].join(',');
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setZones(fromServer);
    }
  }, [signature, fromServer]);

  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so tapping a button still taps it.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const save = (next: Zones) => {
    setError(null);
    setZones(next);
    startTransition(async () => {
      const form = new FormData();
      form.set('leagueId', leagueId);
      for (const slug of next.starters) form.append('starters', slug);
      for (const slug of next.reserves) form.append('reserves', slug);
      const result = await saveLineupAction({}, form);
      if (result.error) {
        setError(result.error);
        setZones(fromServer);
      }
    });
  };

  const zoneOf = (slug: string): keyof Zones =>
    zones.starters.includes(slug) ? 'starters' : 'reserves';

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const slug = String(active.id);
    const target = String(over.id);
    if (slug === target) return;

    const from = zoneOf(slug);
    // Dropping on a zone rather than a card — the empty space under the last reserve.
    const to: keyof Zones =
      target === 'starters' || target === 'reserves' ? target : zoneOf(target);

    if (from === to) {
      const list = zones[from];
      const next = arrayMove(list, list.indexOf(slug), list.indexOf(target));
      save({ ...zones, [from]: next });
      return;
    }

    const source = zones[from].filter((item) => item !== slug);
    const destination = [...zones[to]];
    const at = destination.indexOf(target);
    const index = at === -1 ? destination.length : at;

    if (to === 'starters' && zones.starters.length >= lineupSize) {
      // The lineup is full, so a card coming in sends the one it landed on out. Refusing the drop
      // instead would mean benching someone first for every single change.
      const displaced = destination[index];
      if (!displaced) {
        setError(`Your lineup is full at ${lineupSize} — drop onto a starter to swap.`);
        return;
      }
      destination[index] = slug;
      save({ starters: destination, reserves: [displaced, ...source] });
      return;
    }

    destination.splice(index, 0, slug);
    save({ starters: to === 'starters' ? destination : source, reserves: to === 'starters' ? source : destination });
  };

  const toggle = (slug: string) => {
    const from = zoneOf(slug);
    if (from === 'reserves' && zones.starters.length >= lineupSize) {
      setError(`Your lineup is full at ${lineupSize}. Bench someone first.`);
      return;
    }
    const source = zones[from].filter((item) => item !== slug);
    const to: keyof Zones = from === 'starters' ? 'reserves' : 'starters';
    save({
      starters: from === 'starters' ? source : [...zones.starters, slug],
      reserves: from === 'starters' ? [...zones.reserves, slug] : source,
    } as Zones);
  };

  const makeCaptain = (slug: string) => {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set('leagueId', leagueId);
      form.set('pokemonSlug', slug);
      const result = await setCaptainAction({}, form);
      if (result.error) setError(result.error);
    });
  };

  const cardActions = (slug: string, starter: boolean) => (
    <div className="mt-1 flex w-full gap-1">
      <button
        type="button"
        onClick={() => toggle(slug)}
        className="flex-1 rounded-md bg-panel px-2 py-1 text-[11px] font-semibold text-muted transition hover:text-ink"
      >
        {starter ? 'Bench' : 'Start'}
      </button>
      <button
        type="button"
        onClick={() => makeCaptain(slug)}
        title="Make captain"
        aria-label={`Make ${bySlug.get(slug)?.label ?? slug} captain`}
        className="rounded-md bg-panel px-2 py-1 text-[11px] font-semibold text-muted transition hover:text-accent"
      >
        CAP
      </button>
    </div>
  );

  // Shirt numbers run across the whole squad: the six starting, then the bench.
  const numbers = new Map([...zones.starters, ...zones.reserves].map((slug, i) => [slug, i + 1]));
  const cards = (slugs: string[]) =>
    slugs
      .map((slug) => bySlug.get(slug))
      .filter((entry): entry is PlayerCardData => Boolean(entry))
      .map((entry) => ({
        ...entry,
        number: numbers.get(entry.slug) ?? 0,
        starter: zones.starters.includes(entry.slug),
      }));

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      {/* A fixed id: dnd-kit numbers its accessibility ids from a global counter otherwise, and
          the server and the browser count differently, which React reports as a hydration error. */}
      <DndContext
        id="lineup-board"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <section className="rounded-xl border border-line bg-panel">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              Starting lineup · {zones.starters.length} of {lineupSize}
            </h2>
            <span className="text-xs text-muted">bring {bringToMatch} to a match</span>
          </header>
          <div className="p-4">
            <SortableContext items={zones.starters} strategy={rectSortingStrategy}>
              <Zone id="starters">
                {zones.starters.length === 0 ? (
                  <Empty>Nobody starting. Drag someone up from the bench.</Empty>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {cards(zones.starters).map((entry) => (
                      <SortableCard key={entry.slug} entry={entry} disabled={false}>
                        {cardActions(entry.slug, true)}
                      </SortableCard>
                    ))}
                  </div>
                )}
              </Zone>
            </SortableContext>
            <p className="mt-3 text-center text-xs text-muted">
              Drag to reorder, or onto the bench to drop someone. Only these can play.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">
              Bench · {zones.reserves.length}
            </h2>
          </header>
          <div className="p-4">
            <SortableContext items={zones.reserves} strategy={rectSortingStrategy}>
              <Zone id="reserves">
                {zones.reserves.length === 0 ? (
                  <Empty>Nobody on the bench — your whole squad is starting.</Empty>
                ) : (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {cards(zones.reserves).map((entry) => (
                      <SortableCard key={entry.slug} entry={entry} disabled={false}>
                        {cardActions(entry.slug, false)}
                      </SortableCard>
                    ))}
                  </div>
                )}
              </Zone>
            </SortableContext>
          </div>
        </section>
      </DndContext>
    </div>
  );
}
