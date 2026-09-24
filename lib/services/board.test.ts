/**
 * The board's rules that need no database: who wins, when it closes, and what may go up.
 */

import { describe, expect, it } from 'vitest';

import { boardDeck, freeBranch, namedPokemon, nextClose, winningBid } from './board.ts';
import { loadDeck } from './events.ts';

const HOUR = 60 * 60 * 1000;

function bid(teamId: string, amount: number, at = 0) {
  return { teamId, amount, createdAt: new Date(at) };
}

describe('winningBid', () => {
  // Best first, as the league table reads.
  const table = ['top', 'middle', 'bottom'];

  it('is the lowest ask — the club willing to be paid least', () => {
    expect(winningBid([bid('top', 9_000), bid('middle', 4_000), bid('bottom', 12_000)], table)?.teamId).toBe(
      'middle',
    );
  });

  it('goes to the club lower down the table on a tie', () => {
    expect(winningBid([bid('bottom', 5_000, 2), bid('top', 5_000, 1)], table)?.teamId).toBe('bottom');
    expect(winningBid([bid('top', 5_000), bid('middle', 5_000)], table)?.teamId).toBe('middle');
  });

  it('takes a bid of nothing — volunteering is allowed', () => {
    expect(winningBid([bid('top', 0), bid('bottom', 1)], table)?.amount).toBe(0);
  });

  it('is nobody when nobody bid', () => {
    expect(winningBid([], table)).toBeNull();
  });
});

describe('nextClose', () => {
  const start = new Date('2026-09-01T20:00:00Z');

  it('is one period out for the first board', () => {
    expect(nextClose(null, start, 24).getTime()).toBe(start.getTime() + 24 * HOUR);
  });

  it('keeps the beat of the last close rather than drifting to whenever somebody looked', () => {
    const late = new Date(start.getTime() + 3 * HOUR);
    expect(nextClose(start, late, 24).toISOString()).toBe('2026-09-02T20:00:00.000Z');
  });

  it('skips the beats nobody was there for, and opens one board rather than a backlog', () => {
    const weekLater = new Date(start.getTime() + (6 * 24 + 5) * HOUR);
    expect(nextClose(start, weekLater, 24).toISOString()).toBe('2026-09-08T20:00:00.000Z');
  });

  it('follows a period the commissioner has since changed', () => {
    const late = new Date(start.getTime() + HOUR);
    expect(nextClose(start, late, 72).getTime()).toBe(start.getTime() + 72 * HOUR);
  });
});

describe('what may go on the board', () => {
  const deck = loadDeck();
  const board = boardDeck(deck);

  it('never auctions an event a club causes', () => {
    expect(board.some((template) => template.trigger)).toBe(false);
    // The four the countdown still deals, and nothing else.
    expect(deck.filter((template) => template.trigger).map((template) => template.key).sort()).toEqual(
      ['burnout', 'forgotten_man', 'underdogs_invitation', 'unsettled_squad'],
    );
  });

  it('keeps off anything a club could win and then walk away from untouched', () => {
    // Paid to take it, then declined for nothing: free money. Each of these needs its free
    // branch priced before it can go back up.
    const free = deck.filter((template) => !template.trigger && freeBranch(template) !== null);
    for (const template of free) expect(board).not.toContain(template);
    expect(free.map((template) => template.key).sort()).toEqual(
      ['league_bond', 'sponsor_target', 'swap_offer', 'youth_prospect'],
    );
  });

  it('still puts up the announcements, which land on whoever was paid to take them', () => {
    expect(board.filter((template) => template.announcement).map((template) => template.key).sort()).toEqual(
      ['regulation_shift', 'scouting_leak'],
    );
  });
});

describe('namedPokemon', () => {
  it('reads the subject and every Pokémon a branch would act on', () => {
    const named = namedPokemon({
      detail: JSON.stringify({ subject: 'garchomp' }),
      choices: JSON.stringify([
        { key: 'a', effects: [{ kind: 'POKEMON_OUT', pokemonSlug: 'garchomp' }] },
        { key: 'b', effects: [{ kind: 'ZERO_EVS', pokemonSlug: 'torkoal' }, { kind: 'CASH', pokemonSlug: null }] },
      ]),
    });
    expect(named.sort()).toEqual(['garchomp', 'torkoal']);
  });
});
