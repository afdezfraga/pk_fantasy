/**
 * Economy constants. Everything here is a tuning knob — expect to revisit after a season.
 *
 * Money is always an integer number of Pokédollars (₽). Never floats: the ledger must balance
 * exactly, and float drift on thousands of transactions would break `verifyLedger()`.
 */

/** Competitive tiers, best to worst. `UR` is unranked — anything the tier list doesn't mention. */
export const TIERS = ['S', 'A+', 'A', 'B', 'C', 'D', 'UR'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Shop price range for each tier, as [floor, ceiling]. BST places a Pokémon within its band.
 *
 * The scale is steep on purpose: an S-tier starts at the whole ₽300,000 opening budget, so the
 * first real choice is one star or a balanced squad. Wins refill the wallet, and winning streaks
 * multiply that, so the top of the market opens up to teams that keep winning.
 */
export const TIER_PRICE_BANDS: Record<Tier, readonly [number, number]> = {
  S: [300_000, 400_000],
  'A+': [150_000, 250_000],
  A: [90_000, 140_000],
  B: [40_000, 80_000],
  C: [10_000, 35_000],
  D: [2_000, 9_000],
  UR: [1_000, 10_000],
};

export const PRICING = {
  bstMin: 400,
  bstMax: 650,
  /** All prices round to this, so the market reads cleanly. */
  roundTo: 1_000,
} as const;

/** The better (cheaper index) of two tiers. */
export function betterTier(a: Tier, b: Tier): Tier {
  return TIERS.indexOf(a) <= TIERS.indexOf(b) ? a : b;
}

/**
 * Market value from competitive tier, nudged by base stats.
 *
 * Tier is the signal that matters. Incineroar is a VGC staple on utility — Intimidate, Fake
 * Out, pivoting — rather than raw stats, so any stat-derived price would badly underrate it.
 * BST only places a Pokémon *within* its tier's band, so the market isn't full of identical prices.
 *
 * `tier` should already be the best tier the Pokémon can reach including its Megas: owning
 * Charizard grants Mega Charizard Y, so Charizard prices as A+. See `effectiveTier` in
 * scripts/build-roster.ts.
 */
export function computeBaseValue(input: { tier: Tier; effectiveBst: number }): number {
  const span = PRICING.bstMax - PRICING.bstMin;
  const normalized = Math.min(Math.max((input.effectiveBst - PRICING.bstMin) / span, 0), 1);

  // `UR` means the tier list doesn't mention this Pokémon — that's missing data, not evidence
  // it's bad. Its band is wide and priced on stats, so a quietly strong one (Palafin transforms
  // into a 650-BST monster and goes unranked) still costs a little more than filler.
  const [low, high] = TIER_PRICE_BANDS[input.tier];
  return roundTo(low + (high - low) * normalized, PRICING.roundTo);
}

export function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Defaults copied into `League.config` at creation, editable per league by the commissioner. */
export const LEAGUE_DEFAULTS = {
  /** Money is only for signing Pokémon: there are no wages or upkeep to budget for. */
  startingCash: 300_000,
  /**
   * Hard floor on squad size — how far you may sell down.
   *
   * Deliberately 1, not 6. Spending your whole budget early is a legitimate (if painful) way to
   * play: you end up with one expensive Pokémon and skip the rest of the draft. A team in that
   * position must still be able to sell its way out of trouble, so the floor can't sit above
   * what an overspent squad actually holds.
   */
  squadMin: 1,
  squadMax: 12,
  /**
   * The starting lineup: how many of your squad are match-eligible at once.
   *
   * A hard rule, not guidance — only a starter can appear in a reported match. The rest of the
   * squad are reserves you can rotate in between matches, which is what makes signing a twelfth
   * Pokémon a real decision rather than a free upgrade.
   */
  lineupSize: 6,
  /** How many of the starting lineup you take into a single ladder match. */
  bringToMatch: 4,
  /** Rounds in the opening draft. Teams that run out of money simply skip their later picks. */
  draftRounds: 6,

  /**
   * Whether Pokémon you can't catch in Champions — transfer-only or event-only — can be signed.
   *
   * Exactly one asset is affected today: Eternal Flower Floette, which carries an S-tier Mega.
   * On by default, because results here are self-reported anyway: whether you actually have one
   * to battle with is between you and your save file, and hiding it from the market only made it
   * look like the roster was incomplete. Set to 0 for a league that wants catchable-only.
   */
  allowTransferOnly: 1,

  /** Rounds a newly-freed Pokémon sits on waivers before hitting the open market. */
  waiverHoldRounds: 1,

  /**
   * Random events: problems a manager answers, drawn every few matches. See data/events.json.
   *
   * Set to 0 for a league that just wants to grind the ladder — nothing else changes, and a
   * league already running picks the default up through `parseConfig`.
   */
  eventsEnabled: 1,
  /**
   * Matches a club reports between events.
   *
   * Counted per club rather than per round, because rounds close whenever the commissioner
   * gets round to it while matches are the clock every manager actually feels. It also means
   * the player logging forty matches a week meets more crises than the one logging five,
   * which pulls the same direction as `PAYOUTS.paidMatchesPerRound`.
   */
  eventEveryMatches: 5,
  /** Spread either side of that, so the timing can't be counted and played around. */
  eventJitter: 1,
  /**
   * Percentage scaler on every event cost and penalty.
   *
   * The deck is tuned to take things away, and a season is the only way to find out whether
   * that reads as tense or as miserable. This is the dial to turn when you find out, without
   * editing twenty events.
   */
  eventSeverity: 100,
} as const;

/**
 * Every league setting is a plain number. Derived from the defaults' keys so the two can't drift
 * apart, but deliberately widened — `as const` above would otherwise type `squadMax` as the
 * literal `12` and reject any league that changes it.
 */
export type LeagueConfig = { -readonly [K in keyof typeof LEAGUE_DEFAULTS]: number };

/**
 * How an owned Pokémon's value moves. Its value is what you get back when you sell it.
 *
 * Signing costs the full shop price but the Pokémon is immediately worth only `buyKeepPct` of it,
 * so flipping a signing loses money. From then on every match it plays moves its value by a
 * percentage that depends on the ladder tier the match was played in: winning low barely helps
 * and losing low hurts, while at the top it's the other way round.
 */
export const VALUE_RULES = {
  buyKeepPct: 45,
  /** Keyed by ladder tier (data/ranks.json). Percent change per match, for Pokémon that played. */
  perf: {
    beginner: { win: 3, loss: -3 },
    poke: { win: 3, loss: -3 },
    great: { win: 4, loss: -3 },
    ultra: { win: 5, loss: -2 },
    master: { win: 6, loss: -2 },
    champion: { win: 6, loss: -2 },
  } as Record<string, { win: number; loss: number }>,
  /** A Pokémon's value never falls below this. */
  minValue: 1_000,
} as const;

/** What a Pokémon is worth the moment after you pay `price` for it. */
export function buyValue(price: number): number {
  return Math.max(VALUE_RULES.minValue, Math.round((price * VALUE_RULES.buyKeepPct) / 100));
}

/** Value after a percentage move, never below the floor. */
export function applyPct(value: number, pct: number): number {
  return Math.max(VALUE_RULES.minValue, Math.round(value * (1 + pct / 100)));
}

/** The value move for a match in this ladder tier, in percent. */
export function valuePerf(tierKey: string, won: boolean): number {
  const rule = VALUE_RULES.perf[tierKey] ?? { win: 0, loss: 0 };
  return won ? rule.win : rule.loss;
}
