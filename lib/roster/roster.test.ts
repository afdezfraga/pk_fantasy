/**
 * Guards the generated `data/roster.json`.
 *
 * These run against the committed file rather than the network, so they also serve as a review
 * gate: if a roster rebuild introduces something odd, this fails before anyone drafts on it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TIERS } from '../../config/economy.ts';
import type { RosterFile } from './types.ts';

const roster: RosterFile = JSON.parse(readFileSync(new URL('../../data/roster.json', import.meta.url), 'utf8'));
const { pokemon } = roster;

describe('generated roster', () => {
  it('is populated and self-consistent with its own counts', () => {
    expect(pokemon.length).toBeGreaterThan(200);
    expect(roster.counts.assets).toBe(pokemon.length);
    expect(roster.counts.megas).toBe(pokemon.reduce((n, p) => n + p.megas.length, 0));
  });

  it('records the exact wiki revision it came from', () => {
    expect(roster.source.revisionId).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(roster.generatedAt))).toBe(false);
  });

  // Slugs are the ownership key. A duplicate would let two teams own "different" Pokémon that
  // are really the same one, quietly breaking the league's central rule.
  it('has unique slugs', () => {
    const slugs = pokemon.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has unique Mega slugs across the whole roster', () => {
    const megaSlugs = pokemon.flatMap((p) => p.megas.map((m) => m.slug));
    expect(new Set(megaSlugs).size).toBe(megaSlugs.length);
  });

  it('uses URL-safe, readable slugs', () => {
    for (const entry of pokemon) {
      expect(entry.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('gives every Pokémon types, stats and a valid tier', () => {
    for (const entry of pokemon) {
      expect(entry.types.length, entry.slug).toBeGreaterThanOrEqual(1);
      expect(entry.types.length, entry.slug).toBeLessThanOrEqual(2);
      expect(entry.bst, entry.slug).toBeGreaterThan(0);
      expect(TIERS, entry.slug).toContain(entry.tier);
      expect(entry.baseValue, entry.slug).toBeGreaterThan(0);
    }
  });

  it('never prices a Pokémon below the strongest form it can reach', () => {
    for (const entry of pokemon) {
      const strongest = Math.max(entry.bst, ...entry.megas.map((m) => m.bst));
      expect(entry.effectiveBst, entry.slug).toBeGreaterThanOrEqual(strongest);
    }
  });

  it('keeps regional forms as assets separate from their base species', () => {
    const raichu = pokemon.find((p) => p.slug === 'raichu');
    const alolan = pokemon.find((p) => p.slug === 'raichu-alola');
    expect(raichu).toBeDefined();
    expect(alolan).toBeDefined();
    expect(alolan!.types).toContain('Psychic');
  });

  it('attaches both of Charizard’s Megas to the one tradable Charizard', () => {
    const charizard = pokemon.find((p) => p.slug === 'charizard');
    expect(charizard!.megas.map((m) => m.slug).sort()).toEqual([
      'charizard-mega-x',
      'charizard-mega-y',
    ]);
    // Megas are not separately ownable, so they must not appear as their own assets.
    expect(pokemon.some((p) => p.slug === 'charizard-mega-y')).toBe(false);
  });

  it('keeps a transfer-only Pokémon on the roster, flagged rather than excluded', () => {
    // Eternal Flower Floette can't be caught in Champions, but it is on the roster and carries
    // an S-tier Mega. Treating "can't catch one" as "isn't in the game" hid the only Pokémon
    // affected from the market entirely, which read as a broken roster.
    const floette = pokemon.find((p) => p.slug === 'floette-eternal');
    expect(floette, 'Eternal Flower Floette should be in the roster').toBeDefined();
    expect(floette!.legal).toBe(true);
    expect(floette!.restricted).toBe(true);
    expect(floette!.notes).toBe('Transfer only');
  });

  it('flags only the Pokémon the source actually restricts', () => {
    // A blanket restriction would quietly shrink the league; this is the guard against one.
    expect(pokemon.filter((p) => p.restricted).map((p) => p.slug)).toEqual(['floette-eternal']);
  });

  it('carries both sprite sizes for every Pokémon', () => {
    // Lists render the small game sprite and cards the HOME render; a missing URL means a
    // placeholder box where a Pokémon should be.
    expect(pokemon.filter((p) => !p.iconUrl)).toEqual([]);
    expect(pokemon.filter((p) => !p.homeUrl)).toEqual([]);
  });

  it('reflects the doubles meta rather than singles', () => {
    // The single sharpest signal that the wrong tier list is in use: Incineroar is the premier
    // doubles support Pokémon but only mid-table in singles.
    const incineroar = pokemon.find((p) => p.slug === 'incineroar');
    expect(incineroar!.tier).toBe('S');
  });
});
