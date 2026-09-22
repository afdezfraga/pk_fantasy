/**
 * The deck, checked without touching a database.
 *
 * The validation test is the load-bearing one. Reporting a match is blocked while an event is
 * pending, so a template that offers a club nothing it can afford is not a balance problem —
 * it is a league that can never play again. That invariant is worth a test that runs on every
 * commit rather than a rule in a comment.
 */

import { describe, expect, it } from 'vitest';

import { isAttested, isEffectKind, isInstant, cashCost, bringLimit, payoutMultiplier, valueMultiplier, enforce, EffectViolation, type LiveEffect } from './effects.ts';
import { loadDeck, materialise, pickWeighted, validateDeck, type EventTemplate } from './events.ts';
import { fires, meetsRequires, type EventContext } from './triggers.ts';

describe('the shipped deck', () => {
  const deck = loadDeck();

  it('is valid', () => {
    expect(validateDeck(deck)).toEqual([]);
  });

  it('gives every club something it can always click', () => {
    // The one that keeps hard block from stranding anybody.
    for (const template of deck) {
      const free = template.options.filter((option) => !option.cost && !option.requires);
      expect(free.length, `${template.key} has no unconditional option`).toBeGreaterThan(0);
    }
  });

  it('never charges a percentage without a floor', () => {
    // 12% of nothing is nothing, and an event that only bites the rich is not an event.
    for (const template of deck) {
      for (const option of template.options) {
        if (!option.cost) continue;
        expect(option.cost.min, `${template.key}/${option.key}`).toBeGreaterThan(0);
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

  it('rejects a bond priced as a percentage with no floor', () => {
    // The same rule as every other charge: 20% of nothing is nothing.
    const options = [
      { ...base.options[0], effects: [{ kind: 'ESCROW', pct: 20, returnPct: 115, rounds: 2, label: 'x', liftedMessage: 'y' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/needs a "min" floor/);
  });

  it('rejects a swap with no idea what "similar value" means', () => {
    const options = [
      { ...base.options[0], effects: [{ kind: 'SWAP_OFFER' }] },
      base.options[1],
    ];
    expect(validateDeck([{ ...base, options }]).join(' ')).toMatch(/SWAP_OFFER needs a band/);
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
    types: ['Normal'],
    hasMega: false,
    ...overrides,
  };
}

function context(overrides: Partial<EventContext>): EventContext {
  return {
    leagueId: 'L',
    teamId: 'T',
    teamName: 'Team',
    round: 1,
    cash: 100_000,
    tierKey: 'great',
    matchesPlayed: 10,
    winStreak: 0,
    losingStreak: 0,
    squad: [member('a', { marketValue: 50_000 }), member('b'), member('c'), member('d')],
    squadSize: 4,
    squadRoom: 4,
    squadValue: 80_000,
    freeAgents: [],
    ownedTypes: ['Normal'],
    hasCaptain: false,
    captainAvailable: false,
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
    { pokemonSlug: 'x', name: 'X', form: null, marketValue: 9_000 },
    { pokemonSlug: 'y', name: 'Y', form: null, marketValue: 7_000 },
    { pokemonSlug: 'z', name: 'Z', form: null, marketValue: 5_000 },
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

  it('names who arrives, under a ceiling set by who leaves', () => {
    const offer = materialise(
      template,
      context({
        squad: [
          member('best', { marketValue: 100_000 }),
          member('b', { marketValue: 80_000 }),
          member('c', { marketValue: 60_000 }),
          member('d', { marketValue: 40_000 }),
          member('worst', { marketValue: 20_000 }),
        ],
        freeAgents: market,
      }),
      null,
      () => 0.5,
    );

    // 40% of ₽100,000 buys the two best under ₽40,000; 40% of ₽20,000 buys only what is under
    // ₽8,000, which is a materially worse deal and is stated as such before you click.
    const fromBest = offer.options.find((option) => option.key === 'release:best')!;
    expect(fromBest.detail).toContain('X and Y');
    expect(fromBest.effects[0].params.slugs).toEqual(['x', 'y']);
    expect(fromBest.effects[0].params.amount).toBe(40_000);

    const fromWorst = offer.options.find((option) => option.key === 'release:worst')!;
    expect(fromWorst.effects[0].params.slugs).toEqual(['y', 'z']);
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
        // One agent under the ₽20,000 ceiling where the offer promises two.
        freeAgents: [{ pokemonSlug: 'x', name: 'X', form: null, marketValue: 9_000 }],
      }),
      null,
      () => 0.5,
    );

    const release = offer.options.find((option) => option.key.startsWith('release:'))!;
    expect(release.available).toBe(false);
    expect(release.unavailableReason).toContain('1 free agent');
    // And the club can still answer, which is the whole point of the rule.
    expect(offer.options.find((option) => option.key === 'decline')!.available).toBe(true);
  });

  it('names the Pokémon coming the other way in a swap', () => {
    const swap = loadDeck().find((entry) => entry.key === 'swap_offer')!;
    const offer = materialise(
      swap,
      context({
        squad: [
          member('a', { marketValue: 50_000 }),
          member('b'),
          member('c'),
          member('d'),
        ],
        freeAgents: [
          { pokemonSlug: 'far', name: 'Far', form: null, marketValue: 9_000 },
          { pokemonSlug: 'near', name: 'Near', form: null, marketValue: 52_000 },
        ],
      }),
      null,
      () => 0,
    );

    const take = offer.options.find((option) => option.key === 'swap')!;
    expect(take.effects[0].params.slug).toBe('near');
    expect(take.detail).toContain('Near');
    expect(take.available).toBe(true);
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

  it('never lets a bring limit raise the ceiling', () => {
    expect(bringLimit([effect('BRING_LIMIT', { params: { count: 3 } })], 4)).toBe(3);
    expect(bringLimit([effect('BRING_LIMIT', { params: { count: 9 } })], 4)).toBe(4);
    expect(bringLimit([], 4)).toBe(4);
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
    const result = enforce({ effects: [], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4 });
    expect(result.surrendered).toBe(false);
    expect(result.constraints).toEqual([]);
  });

  it('refuses a Pokémon that is out, while the club has cover', () => {
    const out = effect('POKEMON_OUT', { pokemonSlug: 'a', label: 'a — injured' });
    expect(() =>
      enforce({ effects: [out], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4 }),
    ).toThrow(EffectViolation);
  });

  it('bans by type, since the app can check those', () => {
    const ban = effect('TYPE_BAN', { params: { type: 'Fire' }, label: 'No Fire-types' });
    expect(() =>
      enforce({ effects: [ban], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4 }),
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
      bringToMatch: 4,
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
      bringToMatch: 4,
    });
    expect(result.surrendered).toBe(true);
    expect(result.surrenderReason).toBe('a — suspended');
  });

  it('insists a must-field Pokémon actually plays', () => {
    const must = effect('MUST_FIELD', { pokemonSlug: 'f', label: 'f must start' });
    expect(() =>
      enforce({ effects: [must], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4 }),
    ).toThrow(/has to play/);
  });

  it('holds the report until an honour-based rule is confirmed', () => {
    const mega = effect('NO_MEGA', { label: 'No Mega Evolution' });
    expect(() =>
      enforce({ effects: [mega], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4 }),
    ).toThrow(/Confirm you played under/);

    const result = enforce({
      effects: [mega],
      squad,
      lines: lines(['a', 'b', 'c', 'd']),
      attested: [mega.id],
      bringToMatch: 4,
    });
    expect(result.constraints).toEqual([
      { kind: 'NO_MEGA', label: 'No Mega Evolution', attested: true, honoured: true },
    ]);
  });

  it('enforces a bring limit', () => {
    const limit = effect('BRING_LIMIT', { params: { count: 3 }, label: 'Bring only 3' });
    expect(() =>
      enforce({ effects: [limit], squad, lines: lines(['a', 'b', 'c', 'd']), attested: [], bringToMatch: 4 }),
    ).toThrow(/only bring 3/);
  });
});
