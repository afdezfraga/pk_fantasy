/**
 * The deck, checked without touching a database.
 *
 * The validation test is the load-bearing one. Reporting a match is blocked while an event is
 * pending, so a template that offers a club nothing it can afford is not a balance problem —
 * it is a league that can never play again. That invariant is worth a test that runs on every
 * commit rather than a rule in a comment.
 */

import { describe, expect, it } from 'vitest';

import { contradicts, isAttested, isEffectKind, isInstant, cashCost, lineupCap, payoutMultiplier, valueMultiplier, enforce, EffectViolation, type LiveEffect } from './effects.ts';
import { loadDeck, materialise, pickWeighted, validateDeck, type EventTemplate } from './events.ts';
import { fires, meetsRequires, type EventContext } from './triggers.ts';

describe('the shipped deck', () => {
  const deck = loadDeck();

  it('is valid', () => {
    expect(validateDeck(deck)).toEqual([]);
  });

  it('gives every club something it can always click', () => {
    // The one that keeps hard block from stranding anybody. An announcement is exempt by
    // construction: it never goes PENDING, so it never blocks a report in the first place.
    for (const template of deck.filter((entry) => !entry.announcement)) {
      const free = template.options.filter((option) => !option.cost && !option.requires);
      expect(free.length, `${template.key} has no unconditional option`).toBeGreaterThan(0);
    }
  });

  it('never leaves an announcement asking for an answer', () => {
    for (const template of deck.filter((entry) => entry.announcement)) {
      expect(template.options, `${template.key} is news, not a question`).toEqual([]);
      expect(template.effects?.length, `${template.key} does nothing`).toBeGreaterThan(0);
    }
  });

  it('never charges a percentage without a floor, nor a flat sum of nothing', () => {
    // 12% of nothing is nothing, and an event that only bites the rich is not an event. A flat
    // cost has no floor to set — it is the floor — but it does have to be a real number.
    for (const template of deck) {
      for (const option of template.options) {
        if (!option.cost) continue;
        const where = `${template.key}/${option.key}`;
        if (option.cost.kind === 'CASH') {
          expect(option.cost.amount, where).toBeGreaterThan(0);
        } else {
          expect(option.cost.min, where).toBeGreaterThan(0);
        }
      }
    }
  });

  it('describes every lasting restriction, and its end', () => {
    for (const template of deck) {
      const effects = [
        ...template.options.flatMap((option) => option.effects),
        ...(template.virtue?.effects ?? []),
      ];
      for (const effect of effects) {
        if (!isEffectKind(effect.kind) || isInstant(effect.kind)) continue;
        expect(effect.label, `${template.key}: ${effect.kind}`).toBeTruthy();
        expect(effect.liftedMessage, `${template.key}: ${effect.kind}`).toBeTruthy();
      }
    }
  });

  it('carries both enforceable and honour-based consequences', () => {
    const kinds = new Set(
      deck.flatMap((template) => template.options.flatMap((option) => option.effects.map((e) => e.kind))),
    );
    const attested = [...kinds].filter((kind) => isEffectKind(kind) && isAttested(kind));
    const enforced = [...kinds].filter((kind) => isEffectKind(kind) && !isAttested(kind));
    expect(attested.length).toBeGreaterThan(0);
    expect(enforced.length).toBeGreaterThan(0);
  });

  it('only fires triggered events when their trigger has fired', () => {
    // A "the Pokémon you forgot about" event drawn at random is just noise.
    const triggered = deck.filter((template) => template.trigger);
    expect(triggered.length).toBeGreaterThan(0);
    for (const template of triggered) {
      expect(fires(context({}), template.trigger).fired).toBe(false);
    }
  });
});

describe('validateDeck', () => {
  const base: EventTemplate = {
    key: 'x',
    title: 'X',
    description: 'x',
    scope: 'team',
    weight: 1,
    options: [
      { key: 'a', label: 'A', detail: 'a', default: true, effects: [] },
      { key: 'b', label: 'B', detail: 'b', cost: { kind: 'CASH_PCT', pct: 5, min: 100 }, effects: [] },
    ],
  };

  it('accepts a well-formed template', () => {
    expect(validateDeck([base])).toEqual([]);
  });

  it('rejects a template where every option costs something', () => {
    const problems = validateDeck([
      {
        ...base,
        options: base.options.map((option) => ({
          ...option,
          cost: { kind: 'CASH_PCT' as const, pct: 5, min: 100 },
        })),
      },
    ]);
    expect(problems.join(' ')).toMatch(/no cost and no requirements/);
  });

  it('rejects a template with no default branch', () => {
    const options = base.options.map((option) => ({ ...option, default: false }));
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/exactly one option marked default/);
  });

  it('rejects an unknown effect kind', () => {
    const options = [{ ...base.options[0], effects: [{ kind: 'MAKE_TEA' }] }, base.options[1]];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/unknown effect kind/);
  });

  it('rejects a lasting effect that cannot announce itself', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'NO_MEGA', matches: 3 }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/needs a label/);
  });

  it('rejects a duplicate key', () => {
    expect(validateDeck([base, base]).join(' ')).toMatch(/duplicate key/);
  });

  it('rejects a default option that repeats over the squad', () => {
    // It would offer nothing at all to a club with no starters, and the default is the one
    // branch that has to exist for everybody.
    const options = [{ ...base.options[0], repeat: '@starters' as const }, base.options[1]];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/cannot repeat/);
  });

  it('rejects a wager with no target to hit', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'PLEDGE', outOf: 5, rewardWins: 3, label: 'x', liftedMessage: 'y' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/needs wins and outOf/);
  });

  it('rejects a wager asking for more wins than matches', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'PLEDGE', wins: 6, outOf: 5, rewardWins: 3, label: 'x', liftedMessage: 'y' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/no greater than outOf/);
  });

  it('rejects a wager that pays nothing either way', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'PLEDGE', wins: 2, outOf: 5, label: 'x', liftedMessage: 'y' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/reward, a penalty, or both/);
  });

  it('lets a bond be priced as a percentage with no floor, unlike every charge', () => {
    // A floor exists so a broke club still feels a charge. Locked money is not a charge — it
    // comes back with interest — and a floor on it makes the poor commit a far larger share of
    // what they have than the rich, to an opportunity. A bond keeps them out with minCash.
    const options = [
      { ...base.options[0], effects: [{ kind: 'ESCROW', pct: 20, returnPct: 120, rounds: 2, label: 'x', liftedMessage: 'y' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }])).toEqual([]);
  });

  it('still rejects a bond that never says what comes back', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'ESCROW', pct: 20, rounds: 2, label: 'x', liftedMessage: 'y' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/ESCROW needs an amount/);
  });

  it('rejects a swap that never says what the arrival is worth', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'SWAP_OFFER' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/SWAP_OFFER needs a bonusPct/);
  });
});

describe('pickWeighted', () => {
  it('honours the weights', () => {
    const items = [
      { key: 'a', weight: 1 },
      { key: 'b', weight: 3 },
    ];
    expect(pickWeighted(items, () => 0.1)?.key).toBe('a');
    expect(pickWeighted(items, () => 0.9)?.key).toBe('b');
  });

  it('returns nothing from an empty pool', () => {
    expect(pickWeighted([], () => 0.5)).toBeNull();
  });
});

// --- context helpers ----------------------------------------------------------------------------

function member(slug: string, overrides: Partial<EventContext['squad'][number]> = {}) {
  return {
    pokemonSlug: slug,
    name: slug,
    form: null,
    starter: true,
    captain: false,
    marketValue: 10_000,
    tier: 'B',
    types: ['Normal'],
    hasMega: false,
    ...overrides,
  };
}

/** A free agent the market is offering. Tier only matters to the events that name one. */
function agent(slug: string, marketValue: number, tier = 'B') {
  return { pokemonSlug: slug, name: slug[0].toUpperCase() + slug.slice(1), form: null, marketValue, tier };
}

function context(overrides: Partial<EventContext>): EventContext {
  const squad = overrides.squad ?? [member('a'), member('b'), member('c'), member('d')];
  return {
    // Unless a test says otherwise, the pecking order is the squad order it handed us.
    mostUsed: squad.filter((one) => one.starter).map((one) => one.pokemonSlug),
    leagueId: 'L',
    teamId: 'T',
    teamName: 'Team',
    round: 1,
    cash: 100_000,
    tierKey: 'great',
    matchesPlayed: 10,
    winRate: 50,
    winStreak: 0,
    losingStreak: 0,
    squad: [member('a', { marketValue: 50_000 }), member('b'), member('c'), member('d')],
    squadSize: 4,
    squadRoom: 4,
    squadValue: 80_000,
    freeAgents: [],
    ownedTypes: ['Normal'],
    severity: 100,
    hasCaptain: false,
    captainAvailable: false,
    captainTenure: 0,
    captainFromTheStart: false,
    ladderPosition: 1,
    teamCount: 4,
    benched: null,
    everPresent: null,
    churnThisRound: 0,
    ...overrides,
  };
}

describe('meetsRequires', () => {
  it('passes when there is nothing to meet', () => {
    expect(meetsRequires(context({}), undefined)).toBe(true);
  });

  it('gates on a losing streak', () => {
    expect(meetsRequires(context({ losingStreak: 1 }), { minLosingStreak: 3 })).toBe(false);
    expect(meetsRequires(context({ losingStreak: 3 }), { minLosingStreak: 3 })).toBe(true);
  });

  it('knows who is bottom of the table', () => {
    const bottom = context({ ladderPosition: 4, teamCount: 4 });
    expect(meetsRequires(bottom, { bottomOfLadder: true })).toBe(true);
    expect(meetsRequires(bottom, { notBottomOfLadder: true })).toBe(false);
    // A solo league has no bottom — there is nobody to be behind.
    expect(meetsRequires(context({ ladderPosition: 1, teamCount: 1 }), { bottomOfLadder: true })).toBe(false);
  });

  it('gates on owning something that can Mega Evolve', () => {
    expect(meetsRequires(context({}), { hasMega: true })).toBe(false);
    expect(meetsRequires(context({ squad: [member('a', { hasMega: true })] }), { hasMega: true })).toBe(true);
  });
});

describe('fires', () => {
  it('names the Pokémon that caused it', () => {
    const result = fires(context({ benched: { pokemonSlug: 'c', matches: 12 } }), { benchedMatches: 10 });
    expect(result).toEqual({ fired: true, subject: 'c' });
  });

  it('holds off below the threshold', () => {
    expect(fires(context({ benched: { pokemonSlug: 'c', matches: 4 } }), { benchedMatches: 10 }).fired).toBe(false);
  });

  it('catches a Pokémon that never gets a rest', () => {
    expect(fires(context({ everPresent: { pokemonSlug: 'a', matches: 14 } }), { everyMatchStreak: 12 }).fired).toBe(true);
  });
});

describe('letting the club choose who', () => {
  const template = loadDeck().find((entry) => entry.key === 'release_for_two')!;

  const market = [
    agent('x', 9_000),
    agent('y', 7_000),
    agent('z', 5_000),
  ];

  it('offers one branch per Pokémon, spread across the squad by value', () => {
    const offer = materialise(
      template,
      context({
        squad: [
          member('best', { marketValue: 100_000 }),
          member('upper', { marketValue: 80_000 }),
          member('middle', { marketValue: 60_000 }),
          member('lower', { marketValue: 40_000 }),
          member('worst', { marketValue: 20_000 }),
        ],
        freeAgents: market,
      }),
      null,
      () => 0.5,
    );

    // The best, the middle and the worst — asking a real question rather than three shades of
    // the same one.
    const keys = offer.options.map((option) => option.key);
    expect(keys).toEqual(['release:best', 'release:middle', 'release:worst', 'decline']);
    expect(offer.options[0].label).toContain('best');
  });

  it('names the tier and the price, and nobody at all', () => {
    // What the club accepts is a tier and a count. Naming the two arrivals here would settle a
    // gamble before it is taken, and pinning them would let a club read the market and pick the
    // branch whose names it liked — which is the opposite of what this offer is.
    const offer = materialise(
      template,
      context({
        squad: [
          member('best', { marketValue: 100_000, tier: 'A' }),
          member('b', { marketValue: 80_000 }),
          member('c', { marketValue: 60_000 }),
          member('d', { marketValue: 40_000 }),
          member('worst', { marketValue: 20_000, tier: 'C' }),
        ],
        freeAgents: [agent('x', 30_000, 'A'), agent('y', 9_000, 'A'), agent('z', 5_000, 'C')],
      }),
      null,
      () => 0.5,
    );

    const fromBest = offer.options.find((option) => option.key === 'release:best')!;
    expect(fromBest.effects[0].params.slugs).toBeUndefined();
    expect(fromBest.effects[0].params.tiers).toEqual(['A']);
    expect(fromBest.detail).toContain('A tier');
    // Half of what the leaver was worth, which is what each arrival will be set to.
    expect(fromBest.effects[0].params.amount).toBe(100_000);
    expect(fromBest.effects[0].params.pct).toBe(50);

    // Only one unsigned C, so the cheapest branch cannot be filled and says so.
    const fromWorst = offer.options.find((option) => option.key === 'release:worst')!;
    expect(fromWorst.available).toBe(false);
  });

  it('closes a branch the market cannot actually fill', () => {
    const offer = materialise(
      template,
      context({
        squad: [
          member('a', { marketValue: 50_000 }),
          member('b', { marketValue: 50_000 }),
          member('c', { marketValue: 50_000 }),
          member('d', { marketValue: 50_000 }),
          member('e', { marketValue: 50_000 }),
        ],
        // One unsigned B where the offer promises two of them.
        freeAgents: [agent('x', 9_000, 'B')],
      }),
      null,
      () => 0.5,
    );

    const release = offer.options.find((option) => option.key.startsWith('release:'))!;
    expect(release.available).toBe(false);
    expect(release.unavailableReason).toContain('only 1 unsigned B tier');
    // And the club can still answer, which is the whole point of the rule.
    expect(offer.options.find((option) => option.key === 'decline')!.available).toBe(true);
  });

  it('swaps for standing, not for a number', () => {
    // The two marketValue columns are not the same quantity — an owned Pokémon carries a share
    // of what was paid for it, a free agent the full shop price — so matching one against the
    // other handed over a Pokémon for one worth roughly half as much. Tier is the honest
    // statement of standing, and the cheap B tier here must lose to the A that is in band.
    const swap = loadDeck().find((entry) => entry.key === 'swap_offer')!;
    const offer = materialise(
      swap,
      context({
        squad: [
          member('a', { marketValue: 50_000, tier: 'A' }),
          member('b'),
          member('c'),
          member('d'),
        ],
        freeAgents: [
          agent('sameprice', 50_000, 'B'),
          agent('standing', 9_000, 'A'),
        ],
      }),
      null,
      () => 0,
    );

    const take = offer.options.find((option) => option.key === 'swap')!;
    expect(take.effects[0].params.slug).toBe('standing');
    expect(take.detail).toContain('Standing');
    expect(take.detail).toContain('A tier');
    expect(take.available).toBe(true);
  });

  it('leaves the sold Pokémon out of the fallout it caused', () => {
    // The squad that stays behind is what the sale is about. A restriction written against a
    // Pokémon another club now owns is a row nobody can ever serve, and the arrival landing in
    // the same breath was never in the dressing room to be upset by it.
    const swap = loadDeck().find((entry) => entry.key === 'swap_offer')!;
    const offer = materialise(
      swap,
      context({
        squad: [
          member('a', { marketValue: 50_000, tier: 'A' }),
          member('b'),
          member('c'),
          member('d'),
        ],
        freeAgents: [agent('standing', 9_000, 'A')],
      }),
      null,
      () => 0,
    );

    const deal = offer.options.find((option) => option.key === 'swap')!;
    const sulking = deal.effects.filter((effect) => effect.kind === 'ZERO_EVS');
    expect(sulking.map((effect) => effect.pokemonSlug).sort()).toEqual(['b', 'c', 'd']);
    expect(sulking.every((effect) => effect.matches === 2)).toBe(true);
  });

  it('will reach one rung up the market, but no further', () => {
    const swap = loadDeck().find((entry) => entry.key === 'swap_offer')!;
    const pool = (tiers: string[]) =>
      materialise(
        swap,
        context({
          squad: [
            member('a', { marketValue: 50_000, tier: 'A' }),
            member('b'),
            member('c'),
            member('d'),
          ],
          freeAgents: tiers.map((tier, index) => agent(`f${index}`, 9_000, tier)),
        }),
        null,
        () => 0,
      ).options.find((option) => option.key === 'swap')!;

    // An A may be swapped for an A+ — the rung above — but never for an S.
    expect(pool(['A+']).effects[0].params.slug).toBe('f0');
    expect(pool(['S']).available).toBe(false);
    expect(pool(['B']).available).toBe(false);
  });
});

describe('money priced in wins', () => {
  const template = loadDeck().find((entry) => entry.key === 'sponsor_target')!;

  it('scales a wager to what the club\u2019s own matches are worth', () => {
    // A win pays ₽2,000 in Great and ₽25,000 in Master, so one flat figure would be pocket
    // change to one club and a season's earnings to another.
    const great = materialise(template, context({ tierKey: 'great' }), null, () => 0.5);
    const master = materialise(template, context({ tierKey: 'master' }), null, () => 0.5);

    const modest = (offer: ReturnType<typeof materialise>) =>
      offer.options.find((option) => option.key === 'modest')!.effects[0].params;

    expect(modest(great).reward).toBe(6_000);
    expect(modest(master).reward).toBe(75_000);
    expect(modest(great).penalty).toBe(2_000);

    // And the number on the button is the number that will be paid.
    expect(great.options.find((option) => option.key === 'modest')!.detail).toContain('₽6,000');
  });

  it('gives a wager exactly as many matches as its window', () => {
    const offer = materialise(template, context({}), null, () => 0.5);
    const reckless = offer.options.find((option) => option.key === 'reckless')!;
    expect(reckless.effects[0].matches).toBe(5);
    expect(reckless.effects[0].params.wins).toBe(5);
  });
});

describe('the invitation only a struggling club gets', () => {
  const template = loadDeck().find((entry) => entry.key === 'underdogs_invitation')!;

  it('is closed to a club that is bottom but winning', () => {
    // Bottom of a table can happen on results alone. Bottom *and* losing most weeks is the
    // season this event is written for, and the one a windfall is not an insult to.
    expect(meetsRequires(context({ matchesPlayed: 14, winRate: 55 }), template.requires)).toBe(false);
    expect(meetsRequires(context({ matchesPlayed: 14, winRate: 25 }), template.requires)).toBe(true);
    // And never before a club has played enough for the table to mean anything.
    expect(meetsRequires(context({ matchesPlayed: 4, winRate: 0 }), template.requires)).toBe(false);
  });

  it('closes the prize when the top tiers have all been signed', () => {
    const empty = materialise(template, context({ freeAgents: [agent('x', 9_000, 'C')] }), null, () => 0.5);
    const shut = empty.options.find((option) => option.key === 'prospect')!;
    expect(shut.available).toBe(false);
    expect(shut.unavailableReason).toContain('tier Pokémon left unsigned');
    // The money is always there, so the club is never stuck behind an empty market.
    expect(empty.options.find((option) => option.key === 'money')!.available).toBe(true);

    const stocked = materialise(template, context({ freeAgents: [agent('x', 90_000, 'S')] }), null, () => 0.5);
    expect(stocked.options.find((option) => option.key === 'prospect')!.available).toBe(true);
  });

  it('never names the prize, because the gamble is the point', () => {
    const offer = materialise(template, context({ freeAgents: [agent('x', 90_000, 'S')] }), null, () => 0.5);
    const prize = offer.options.find((option) => option.key === 'prospect')!;
    expect(prize.detail).not.toContain('X');
    expect(prize.effects[0].params.slug).toBeUndefined();
    expect(prize.effects[0].params.tiers).toEqual(['S', 'A+']);
  });
});

describe('asking the captain to step in', () => {
  const template = loadDeck().find((entry) => entry.key === 'transfer_request')!;
  const squad = [
    member('a', { marketValue: 50_000, hasMega: true }),
    member('b', { captain: true }),
    member('c'),
    member('d'),
  ];
  const captainOption = (over: Partial<EventContext>) =>
    materialise(template, context({ squad, hasCaptain: true, captainAvailable: true, ...over }), null, () => 0.5)
      .options.find((option) => option.key === 'captain')!;

  it('is closed to a club that has just handed the armband over, and says so', () => {
    const fresh = captainOption({ captainTenure: 3, captainFromTheStart: false });
    expect(fresh.available).toBe(false);
    expect(fresh.unavailableReason).toContain('3 matches');
    expect(fresh.unavailableReason).toContain('15');
  });

  it('opens for one that has worn it from the start, or worn it long enough', () => {
    expect(captainOption({ captainTenure: 0, captainFromTheStart: true }).available).toBe(true);
    expect(captainOption({ captainTenure: 15, captainFromTheStart: false }).available).toBe(true);
    expect(captainOption({ captainTenure: 14, captainFromTheStart: false }).available).toBe(false);
  });

  it('spends the favour in events rather than in matches', () => {
    const spent = captainOption({ captainFromTheStart: true }).effects[0];
    expect(spent.kind).toBe('CAPTAIN_SPENT');
    expect(spent.events).toBe(5);
    expect(spent.matches).toBe(0);
  });

  it('names the reason a club with no captain cannot ask', () => {
    const none = materialise(template, context({ squad: [member('a', { marketValue: 50_000 })] }), null, () => 0.5)
      .options.find((option) => option.key === 'captain')!;
    expect(none.unavailableReason).toBe('Your club has no captain.');
  });
});

describe('the two the club leans on', () => {
  const template = loadDeck().find((entry) => entry.key === 'who_sits_out')!;

  it('names the pecking order, and offers a branch about each', () => {
    const squad = [
      member('spare', { marketValue: 90_000 }),
      member('first'),
      member('second'),
      member('third'),
      member('fourth'),
    ];
    // Usage, not value: the ₽90,000 Pokémon nobody plays is nobody's rival.
    const offer = materialise(
      template,
      context({ squad, mostUsed: ['first', 'second', 'third', 'fourth', 'spare'] }),
      null,
      () => 0.5,
    );

    expect(offer.description).toContain('first and second');
    expect(offer.description).not.toContain('spare');

    const [one, two] = offer.options;
    expect(one.label).toBe('Stand first down');
    expect(one.effects[0].pokemonSlug).toBe('first');
    expect(two.label).toBe('Stand second down');
    expect(two.effects[0].pokemonSlug).toBe('second');
    // Whichever way it goes, somebody sits: both branches are free and one is the fallback.
    expect(offer.options.filter((option) => option.cost === 0 && option.available)).toHaveLength(2);
    expect(two.default).toBe(true);
  });
});

describe('a published risk ladder', () => {
  const template = loadDeck().find((entry) => entry.key === 'knock_in_training')!;

  it('prints the odds it will actually roll on', () => {
    const offer = materialise(template, context({}), null, () => 0.5);
    const rush = offer.options.find((option) => option.key === 'rush')!;

    expect(rush.detail).toContain('nothing at all (1 in 6)');
    expect(rush.detail).toContain('out for 5 matches (3 in 6)');
    expect(rush.effects[0].params.faces).toEqual([0, 1, 2, 5, 5, 5]);
  });

  it('publishes the table this club is on, not the one in the file', () => {
    // A harsher league lengthens every absence, and the printed odds lengthen with it — an
    // event that showed the file's numbers would be lying to half the leagues that run it.
    const harsh = materialise(template, context({ severity: 200 }), null, () => 0.5);
    const rush = harsh.options.find((option) => option.key === 'rush')!;

    expect(rush.effects[0].params.faces).toEqual([0, 2, 4, 10, 10, 10]);
    expect(rush.detail).toContain('out for 10 matches (3 in 6)');
    // Nothing at all stays nothing at all: severity makes consequences worse, not inevitable.
    expect(rush.detail).toContain('nothing at all (1 in 6)');
  });
});

describe('restrictions that cannot both be honoured', () => {
  it('knows which pairs contradict, in either order', () => {
    expect(contradicts('POKEMON_OUT', 'MUST_FIELD')).toBe(true);
    expect(contradicts('MUST_FIELD', 'POKEMON_OUT')).toBe(true);
    expect(contradicts('POKEMON_OUT', 'MUST_LEAD')).toBe(true);
    expect(contradicts('STAB_ONLY', 'NO_STAB')).toBe(true);
    expect(contradicts('NO_ITEM', 'FIXED_ITEM')).toBe(true);
    // Two restrictions that merely stack are not a contradiction, however unpleasant.
    expect(contradicts('NO_MEGA', 'ZERO_EVS')).toBe(false);
    expect(contradicts('POKEMON_OUT', 'POKEMON_OUT')).toBe(false);
  });

  it('lets a club report when an injury and a promise are both somehow in force', () => {
    const squad = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug) => ({
      pokemonSlug: slug,
      starter: true,
      types: ['Normal'],
    }));
    const effects = [
      effect('POKEMON_OUT', { pokemonSlug: 'a', label: 'A — out injured' }),
      effect('MUST_FIELD', { pokemonSlug: 'a', label: 'A must play' }),
    ];
    const result = enforce({
      effects,
      squad,
      lines: ['b', 'c', 'd', 'e'].map((slug) => ({ pokemonSlug: slug, benched: false })),
      attested: [],
      bringToMatch: 4,
      lineupSize: 6,
    });
    expect(result.surrendered).toBe(false);
  });
});

describe('a promise nobody could break', () => {
  const template = loadDeck().find((entry) => entry.key === 'transfer_request')!;

  it('drops the Mega ban when the Pokémon it lands on has no Mega', () => {
    const withMega = [member('a', { marketValue: 50_000, hasMega: true }), member('b'), member('c')];
    const without = [member('a', { marketValue: 50_000 }), member('b'), member('c')];

    const kinds = (squad: EventContext['squad']) =>
      materialise(template, context({ squad }), null, () => 0.5)
        .options.find((option) => option.key === 'refuse')!
        .effects.map((effect) => effect.kind);

    expect(kinds(withMega)).toContain('NO_MEGA');
    // The sulk still bites — it just stops asking the manager to tick a box about a Mega
    // Evolution that was never available to them.
    expect(kinds(without)).not.toContain('NO_MEGA');
    expect(kinds(without)).toContain('ZERO_EVS');
  });
});

describe('who an effect is actually about', () => {
  it('leaves a club-wide effect unattached, even when the event names a Pokémon', () => {
    // Burnout is about one exhausted Pokémon, but its virtue lifts the whole club's rewards.
    // Tagging that row with the Pokémon would put it on one card, as though it were personal.
    const burnout = loadDeck().find((entry) => entry.key === 'burnout')!;
    const virtue = materialise(
      { ...burnout, options: [{ key: 'virtue', label: '', detail: '', effects: burnout.virtue!.effects }] },
      context({}),
      'a',
      () => 0.5,
    );
    expect(virtue.options[0].effects[0].kind).toBe('PAYOUT_MULT');
    expect(virtue.options[0].effects[0].pokemonSlug).toBeNull();

    // And one that really is about a Pokémon keeps its name.
    const push = materialise(burnout, context({}), 'a', () => 0.5).options.find(
      (option) => option.key === 'push',
    )!;
    expect(push.effects.map((effect) => effect.pokemonSlug)).toEqual(['a', 'a']);
  });
});

describe('when it lands on the captain', () => {
  const template = loadDeck().find((entry) => entry.key === 'transfer_request')!;

  const squad = (captainSlug: string | null) => [
    member('a', { marketValue: 50_000, captain: captainSlug === 'a' }),
    member('b', { captain: captainSlug === 'b' }),
    member('c'),
    member('d'),
  ];

  it('costs more and lasts longer', () => {
    // @mostValuableStarter picks 'a'; severityMult.captain is 1.5.
    const ordinary = materialise(template, context({ squad: squad('b') }), null, () => 0.5);
    const onCaptain = materialise(template, context({ squad: squad('a') }), null, () => 0.5);

    expect(ordinary.options.find((option) => option.key === 'bonus')!.cost).toBe(7_500);
    expect(onCaptain.options.find((option) => option.key === 'bonus')!.cost).toBe(11_300);

    const evs = (offer: ReturnType<typeof materialise>) =>
      offer.options.find((option) => option.key === 'refuse')!.effects[0].matches;
    expect(evs(ordinary)).toBe(5);
    expect(evs(onCaptain)).toBe(8);
  });

  it('sends the trouble outward when it is refused', () => {
    const offer = materialise(template, context({ squad: squad('a') }), null, () => 0.5);
    const refuse = offer.options.find((option) => option.key === 'refuse')!;

    const zeroEvs = refuse.effects.filter((effect) => effect.kind === 'ZERO_EVS');
    expect(zeroEvs).toHaveLength(3);

    // The one it happened to, and two others who watched it happen for less time.
    const [head, ...rest] = zeroEvs;
    expect(head.pokemonSlug).toBe('a');
    expect(rest.map((effect) => effect.pokemonSlug)).not.toContain('a');
    for (const ripple of rest) {
      expect(ripple.matches).toBeLessThan(head.matches);
      expect(ripple.label).toContain('unsettled');
      expect(ripple.label).not.toContain('{');
    }
  });

  it('leaves everybody else alone when it lands on anybody else', () => {
    const offer = materialise(template, context({ squad: squad('b') }), null, () => 0.5);
    const refuse = offer.options.find((option) => option.key === 'refuse')!;
    // The ripple is not about the captain being the subject — it is about a Pokémon being told
    // no in front of the squad, which happens whoever it is.
    expect(refuse.effects.filter((effect) => effect.kind === 'ZERO_EVS')).toHaveLength(3);
  });
});

describe('every placeholder resolves', () => {
  it('leaves nothing unsubstituted in any template, on any branch', () => {
    // A brace that reaches a manager is a bug they cannot do anything about. The deck is checked
    // whole here rather than one template at a time, so a new placeholder cannot be added to the
    // wording without also being given a value.
    const rich = context({
      squad: [
        member('a', { marketValue: 90_000, captain: true, hasMega: true }),
        member('b', { marketValue: 60_000 }),
        member('c', { marketValue: 40_000 }),
        member('d', { marketValue: 20_000 }),
        member('e', { marketValue: 10_000 }),
      ],
      hasCaptain: true,
      captainAvailable: true,
      freeAgents: [
        agent('w', 88_000),
        agent('x', 30_000),
        agent('y', 20_000),
        agent('z', 8_000),
      ],
    });

    for (const template of loadDeck()) {
      const offer = materialise(template, rich, 'a', () => 0.5);
      expect(offer.description, template.key).not.toContain('{');
      for (const option of offer.options) {
        expect(option.label, `${template.key}/${option.key} label`).not.toContain('{');
        expect(option.detail, `${template.key}/${option.key} detail`).not.toContain('{');
        for (const effect of option.effects) {
          expect(effect.label, `${template.key}/${option.key}/${effect.kind}`).not.toContain('{');
          expect(effect.liftedMessage, `${template.key}/${option.key}/${effect.kind}`).not.toContain(
            '{',
          );
        }
      }

      // The good days go out through the same feed and get the same check.
      if (!template.virtue) continue;
      const virtue = materialise(
        {
          ...template,
          description: template.virtue.description,
          options: [{ key: 'v', label: 'v', detail: 'v', effects: template.virtue.effects }],
        },
        rich,
        'a',
        () => 0.5,
      );
      expect(virtue.description, `${template.key} virtue`).not.toContain('{');
      for (const effect of virtue.options[0].effects) {
        expect(effect.label, `${template.key} virtue/${effect.kind}`).not.toContain('{');
        expect(effect.liftedMessage, `${template.key} virtue/${effect.kind}`).not.toContain('{');
      }
    }
  });
});

describe('the league severity dial', () => {
  const template = loadDeck().find((entry) => entry.key === 'transfer_request')!;

  it('scales what an event costs and how long it bites', () => {
    const half = materialise(template, context({ severity: 50 }), null, () => 0.5);
    const harsh = materialise(template, context({ severity: 200 }), null, () => 0.5);

    expect(half.options.find((option) => option.key === 'bonus')!.cost).toBe(3_800);
    expect(harsh.options.find((option) => option.key === 'bonus')!.cost).toBe(15_000);
    expect(half.options.find((option) => option.key === 'refuse')!.effects[0].matches).toBe(3);
    expect(harsh.options.find((option) => option.key === 'refuse')!.effects[0].matches).toBe(10);
  });

  it('never rounds a consequence away to nothing', () => {
    // A restriction scaled to a fraction of a match is still a restriction.
    const offer = materialise(template, context({ severity: 1 }), null, () => 0.5);
    expect(offer.options.find((option) => option.key === 'refuse')!.effects[0].matches).toBe(1);
  });
});

describe('materialise', () => {
  const template = loadDeck().find((entry) => entry.key === 'transfer_request')!;

  it('names the club and the Pokémon in the copy', () => {
    const offer = materialise(template, context({ teamName: 'Cinnabar' }), null, () => 0.5);
    expect(offer.subject).toBe('a');
    expect(offer.description).toContain('Cinnabar');
    expect(offer.description).toContain('a');
    expect(offer.description).not.toContain('{');
  });

  it('settles the cost in Pokédollars at draw time', () => {
    // 15% of the target's ₽50,000, so the number on the button is the number charged.
    const offer = materialise(template, context({}), null, () => 0.5);
    const bonus = offer.options.find((option) => option.key === 'bonus')!;
    expect(bonus.cost).toBe(7_500);
    expect(bonus.detail).toContain('₽7,500');
  });

  it('closes the captain branch when there is no captain to send', () => {
    const offer = materialise(template, context({}), null, () => 0.5);
    expect(offer.options.find((option) => option.key === 'captain')!.available).toBe(false);
    expect(offer.options.find((option) => option.key === 'refuse')!.available).toBe(true);
  });

  it('leaves the unconditional branch free and always open', () => {
    const offer = materialise(template, context({ cash: 0 }), null, () => 0.5);
    const refuse = offer.options.find((option) => option.key === 'refuse')!;
    expect(refuse.cost).toBe(0);
    expect(refuse.available).toBe(true);
    expect(refuse.default).toBe(true);
  });
});

// --- effects ------------------------------------------------------------------------------------

function effect(kind: string, overrides: Partial<LiveEffect> = {}): LiveEffect {
  return {
    id: `e-${kind}`,
    kind: kind as LiveEffect['kind'],
    pokemonSlug: null,
    params: {},
    matchesLeft: 3,
    eventsLeft: 0,
    untilRound: null,
    attested: isAttested(kind as LiveEffect['kind']),
    label: kind,
    liftedMessage: 'lifted',
    ...overrides,
  };
}

describe('cashCost', () => {
  it('takes a share of the balance', () => {
    expect(cashCost(100_000, { pct: 8, min: 0 })).toBe(8_000);
  });

  it('never drops below its floor, so a broke club still feels it', () => {
    expect(cashCost(0, { pct: 8, min: 10_000 })).toBe(10_000);
    expect(cashCost(-50_000, { pct: 8, min: 10_000 })).toBe(10_000);
  });
});

describe('multipliers', () => {
  it('compounds', () => {
    const effects = [effect('PAYOUT_MULT', { params: { times: 0.5 } }), effect('PAYOUT_MULT', { params: { times: 0.6 } })];
    expect(payoutMultiplier(effects)).toBeCloseTo(0.3);
  });

  it('is 1 when nothing is in force', () => {
    expect(payoutMultiplier([])).toBe(1);
    expect(valueMultiplier([])).toBe(1);
  });

  it('never lets a shortened lineup raise the ceiling', () => {
    expect(lineupCap([effect('LINEUP_LIMIT', { params: { count: 5 } })], 6)).toBe(5);
    expect(lineupCap([effect('LINEUP_LIMIT', { params: { count: 9 } })], 6)).toBe(6);
    expect(lineupCap([], 6)).toBe(6);
  });
});

describe('enforce', () => {
  const squad = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug) => ({
    pokemonSlug: slug,
    starter: true,
    types: slug === 'a' ? ['Fire'] : ['Normal'],
  }));
  const lines = (slugs: string[]) => slugs.map((slug) => ({ pokemonSlug: slug, benched: false }));

  it('passes a clean match', () => {
    const result = enforce({ effects: [], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 });
    expect(result.surrendered).toBe(false);
    expect(result.constraints).toEqual([]);
  });

  it('refuses a Pokémon that is out, while the club has cover', () => {
    const out = effect('POKEMON_OUT', { pokemonSlug: 'a', label: 'a — injured' });
    expect(() =>
      enforce({ effects: [out], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 }),
    ).toThrow(EffectViolation);
  });

  it('bans by type, since the app can check those', () => {
    const ban = effect('TYPE_BAN', { params: { type: 'Fire' }, label: 'No Fire-types' });
    expect(() =>
      enforce({ effects: [ban], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 }),
    ).toThrow(/No Fire-types/);
  });

  it('lets a cornered club bring a banned Pokémon, benched', () => {
    // Four starters, one of them out: enforcing the ban would leave the club unable to field a
    // match at all, and there is no way to report your way back to a full squad.
    const short = squad.slice(0, 4);
    const out = effect('POKEMON_OUT', { pokemonSlug: 'a', label: 'a — suspended' });
    const result = enforce({
      effects: [out],
      squad: short,
      lines: [{ pokemonSlug: 'a', benched: true }, ...lines(['b', 'c', 'd'])],
      attested: [],
      bringToMatch: 4, lineupSize: 6,
    });
    expect(result.surrendered).toBe(false);
  });

  it('records a surrender when the banned Pokémon actually plays', () => {
    const short = squad.slice(0, 4);
    const out = effect('POKEMON_OUT', { pokemonSlug: 'a', label: 'a — suspended' });
    const result = enforce({
      effects: [out],
      squad: short,
      lines: lines(['a', 'b', 'c', 'd']),
      attested: [],
      bringToMatch: 4, lineupSize: 6,
    });
    expect(result.surrendered).toBe(true);
    expect(result.surrenderReason).toBe('a — suspended');
  });

  it('insists a must-field Pokémon actually plays', () => {
    const must = effect('MUST_FIELD', { pokemonSlug: 'f', label: 'f must start' });
    expect(() =>
      enforce({ effects: [must], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 }),
    ).toThrow(/has to play/);
  });

  it('holds the report until an honour-based rule is confirmed', () => {
    const mega = effect('NO_MEGA', { label: 'No Mega Evolution' });
    expect(() =>
      enforce({ effects: [mega], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 }),
    ).toThrow(/Confirm you played under/);

    const result = enforce({
      effects: [mega],
      squad,
      lines: lines(['a', 'b', 'c', 'd']),
      attested: [mega.id],
      bringToMatch: 4,
      lineupSize: 6,
    });
    expect(result.constraints).toEqual([
      { kind: 'NO_MEGA', label: 'No Mega Evolution', attested: true, honoured: true },
    ]);
  });

  it('makes a club drop a name from the sheet, without touching the four it plays', () => {
    const limit = effect('LINEUP_LIMIT', { params: { count: 5 }, label: 'Travelling light' });
    // Six registered, five allowed: refused, and the manager picks who sits out.
    expect(() =>
      enforce({ effects: [limit], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 }),
    ).toThrow(/only 5 of your squad can be registered/);

    // Cut to five, and the same four take the field as always.
    const cut = [...squad.slice(0, 5), { ...squad[5], starter: false }];
    expect(
      enforce({ effects: [limit], squad: cut, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4, lineupSize: 6 })
        .surrendered,
    ).toBe(false);
  });
});
