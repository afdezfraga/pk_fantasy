import { describe, expect, it } from 'vitest';

import { buildSchedule, pickSlot, shuffle } from './draft.ts';

describe('pickSlot', () => {
  const order = ['a', 'b', 'c'];

  it('runs the first round forwards', () => {
    expect(pickSlot(order, 0)).toEqual({ round: 0, teamId: 'a' });
    expect(pickSlot(order, 1)).toEqual({ round: 0, teamId: 'b' });
    expect(pickSlot(order, 2)).toEqual({ round: 0, teamId: 'c' });
  });

  it('reverses the second round so picking last is not a permanent penalty', () => {
    expect(pickSlot(order, 3)).toEqual({ round: 1, teamId: 'c' });
    expect(pickSlot(order, 4)).toEqual({ round: 1, teamId: 'b' });
    expect(pickSlot(order, 5)).toEqual({ round: 1, teamId: 'a' });
  });

  it('alternates again on the third round', () => {
    expect(pickSlot(order, 6)).toEqual({ round: 2, teamId: 'a' });
  });

  it('gives the team at each end back-to-back picks across the turn', () => {
    // The whole point of a snake: c picks at 2 and 3.
    expect(pickSlot(order, 2).teamId).toBe(pickSlot(order, 3).teamId);
  });
});

describe('buildSchedule', () => {
  it('gives every team an equal number of picks', () => {
    const schedule = buildSchedule(['a', 'b', 'c', 'd'], 5);
    expect(schedule).toHaveLength(20);

    const counts = new Map<string, number>();
    for (const slot of schedule) counts.set(slot.teamId, (counts.get(slot.teamId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([5, 5, 5, 5]);
  });

  it('numbers picks contiguously', () => {
    const schedule = buildSchedule(['a', 'b'], 3);
    expect(schedule.map((slot) => slot.overall)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('shuffle', () => {
  it('keeps every team exactly once', () => {
    const teams = ['a', 'b', 'c', 'd', 'e'];
    const shuffled = shuffle(teams, () => 0.42);
    expect([...shuffled].sort()).toEqual([...teams].sort());
  });

  it('does not mutate its input', () => {
    const teams = ['a', 'b', 'c'];
    shuffle(teams);
    expect(teams).toEqual(['a', 'b', 'c']);
  });
});
