/**
 * The random-event deck, loaded from `data/events.json` so new events need no code.
 *
 * Events are the thing that makes a quiet week interesting. They are deliberately modest in
 * size — enough to change a decision, never enough to decide the league.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { roundTo } from '../../config/economy.ts';
import { db } from '../db.ts';
import { audit, postEntry } from './money.ts';
import { parseTypes } from '../format.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export type EffectKind = 'CASH' | 'CASH_PER_POKEMON' | 'VALUE_SPIKE' | 'TYPE_SHIFT' | 'TAX';

export interface EventTemplate {
  key: string;
  title: string;
  description: string;
  scope: 'team' | 'league';
  weight: number;
  effect: {
    kind: EffectKind;
    min?: number;
    max?: number;
    percent?: number;
  };
}

let cache: EventTemplate[] | null = null;

export function loadEvents(): EventTemplate[] {
  if (!cache) {
    const file = JSON.parse(readFileSync(join(ROOT, 'data/events.json'), 'utf8'));
    cache = file.events as EventTemplate[];
  }
  return cache;
}

export function pickWeighted<T extends { weight: number }>(items: T[], random = Math.random): T | null {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return null;

  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

function randomInRange(min: number, max: number, random = Math.random): number {
  return roundTo(min + random() * (max - min), 100);
}

/** Draws an event for the round, or nothing — a quiet week is a legitimate outcome. */
export async function drawEvent(leagueId: string, round: number): Promise<EventTemplate | null> {
  void leagueId;
  void round;
  // One in six rounds passes without incident, so events stay notable.
  if (Math.random() < 1 / 6) return null;
  return pickWeighted(loadEvents());
}

export async function applyEvent(leagueId: string, round: number, template: EventTemplate) {
  const teams = await db.team.findMany({ where: { leagueId } });
  if (teams.length === 0) return null;

  const targets = template.scope === 'team' ? [teams[Math.floor(Math.random() * teams.length)]] : teams;

  let description = template.description;
  const detail: Record<string, unknown> = { key: template.key, scope: template.scope };

  await db.$transaction(async (tx) => {
    switch (template.effect.kind) {
      case 'CASH': {
        const amount = randomInRange(template.effect.min ?? 0, template.effect.max ?? 0);
        for (const team of targets) {
          // Never push a team below zero — an event shouldn't bankrupt someone outright.
          const applied = amount < 0 ? -Math.min(-amount, team.cash) : amount;
          if (applied === 0) continue;
          await postEntry(tx, {
            leagueId,
            teamId: team.id,
            type: 'EVENT',
            amount: applied,
            description: template.title,
          });
        }
        description = description
          .replace('{amount}', Math.abs(amount).toLocaleString())
          .replace('{team}', targets[0]?.name ?? 'A team');
        detail.amount = amount;
        break;
      }

      case 'CASH_PER_POKEMON': {
        const rate = randomInRange(template.effect.min ?? 0, template.effect.max ?? 0);
        for (const team of targets) {
          const count = await tx.ownership.count({ where: { leagueId, teamId: team.id } });
          if (count === 0) continue;
          await postEntry(tx, {
            leagueId,
            teamId: team.id,
            type: 'EVENT',
            amount: rate * count,
            description: `${template.title} (${count} Pokémon)`,
          });
        }
        description = description
          .replace('{amount}', rate.toLocaleString())
          .replace('{team}', targets[0]?.name ?? 'A team');
        detail.rate = rate;
        break;
      }

      case 'TAX': {
        const percent = template.effect.percent ?? 5;
        for (const team of targets) {
          const amount = roundTo((team.cash * percent) / 100, 100);
          if (amount <= 0) continue;
          await postEntry(tx, {
            leagueId,
            teamId: team.id,
            type: 'EVENT',
            amount: -amount,
            description: template.title,
          });
        }
        description = description.replace('{percent}', String(percent));
        detail.percent = percent;
        break;
      }

      case 'VALUE_SPIKE': {
        const percent = template.effect.percent ?? 10;
        // Pick from Pokémon someone actually owns, so the news is about the league.
        const owned = await tx.ownership.findMany({
          where: { leagueId, teamId: { not: null } },
          include: { pokemon: { select: { name: true, form: true } } },
        });
        const pool = owned.length > 0 ? owned : await tx.ownership.findMany({
          where: { leagueId },
          include: { pokemon: { select: { name: true, form: true } } },
          take: 50,
        });
        if (pool.length === 0) break;

        const chosen = pool[Math.floor(Math.random() * pool.length)];
        const next = Math.max(500, roundTo(chosen.marketValue * (1 + percent / 100), 500));
        await tx.ownership.update({ where: { id: chosen.id }, data: { marketValue: next } });

        const label = chosen.pokemon.form
          ? `${chosen.pokemon.name} (${chosen.pokemon.form})`
          : chosen.pokemon.name;
        description = description
          .replace('{pokemon}', label)
          .replace('{percent}', String(Math.abs(percent)));
        detail.pokemonSlug = chosen.pokemonSlug;
        detail.from = chosen.marketValue;
        detail.to = next;
        break;
      }

      case 'TYPE_SHIFT': {
        const percent = template.effect.percent ?? 10;
        const rows = await tx.ownership.findMany({
          where: { leagueId },
          include: { pokemon: { select: { types: true } } },
        });

        const allTypes = [...new Set(rows.flatMap((row) => parseTypes(row.pokemon.types)))];
        if (allTypes.length === 0) break;
        const type = allTypes[Math.floor(Math.random() * allTypes.length)];

        let moved = 0;
        for (const row of rows) {
          if (!parseTypes(row.pokemon.types).includes(type)) continue;
          const next = Math.max(500, roundTo(row.marketValue * (1 + percent / 100), 500));
          if (next === row.marketValue) continue;
          await tx.ownership.update({ where: { id: row.id }, data: { marketValue: next } });
          moved += 1;
        }

        description = description
          .replace('{type}', type)
          .replace('{percent}', `${percent > 0 ? '+' : ''}${percent}`);
        detail.type = type;
        detail.affected = moved;
        break;
      }
    }

    const event = await tx.leagueEvent.create({
      data: {
        leagueId,
        teamId: template.scope === 'team' ? targets[0].id : null,
        round,
        templateKey: template.key,
        title: template.title,
        description,
        detail: JSON.stringify(detail),
      },
    });

    await audit(tx, { leagueId, action: 'EVENT', detail: { eventId: event.id, ...detail } });
  });

  return { title: template.title, description };
}

export async function getEvents(leagueId: string, take = 10) {
  return db.leagueEvent.findMany({
    where: { leagueId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}
