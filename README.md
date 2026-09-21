# Pokémon Champions Fantasy League

A self-hosted fantasy-league / career-mode app for a group of friends playing Pokémon Champions.

Each player runs a team with a cash balance and buys Pokémon from a pool where **only one player
in the league can own each Pokémon**. You then take that squad onto the Champions **ranked
ladder** and grind it yourself — there are no head-to-head league fixtures. You log your matches
and your current rank here, and the league table is simply who has climbed highest.

Money comes from **winning** — the reward depends on the ladder tier you won in, and a winning
streak multiplies it. Your Pokémon gain and lose value with every match they play, and a live
market and player-to-player trades do the rest.

> **Status: playable.** Club pages and crests, a drag-and-drop squad board, draft, market,
> trades, ladder ranks, match reporting and streak rewards all work. Solo play is supported.

## Quick start

```bash
npm install
npm run roster:build   # generate data/roster.json + data/roster.csv (only when the roster rotates)
npm run db:push        # create the SQLite database
npm run db:seed        # load the 247 Pokémon into it
npm run dev            # http://localhost:3000
```

Create an account, start a league, and share the six-character invite code. Once everyone has
joined, the commissioner starts the draft.

### Hosting it for the league

`npm run build && npm run start` serves it properly. It's plain HTTP over your LAN out of the
box; put it behind a TLS-terminating proxy if you expose it to the internet, since session
cookies are marked `secure` in production (set `ALLOW_INSECURE_COOKIE=1` to override on a LAN).
All the league's data lives in `prisma/dev.db` — back that file up.

## The roster pipeline

`npm run roster:build` regenerates the league's Pokémon catalog from two sources:

| Source | Provides |
|---|---|
| [Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_in_Pok%C3%A9mon_Champions) (MediaWiki API) | Which Pokémon are legal in Champions, their forms, Megas, and when each was added |
| [PokéAPI](https://pokeapi.co/) | Base stats and official artwork |
| `data/tiers.json` (hand-maintained) | Competitive tiers, which drive price |

Output is **committed to git**, so a roster rotation shows up as a reviewable diff rather than a
silent change under a running league. Add `-- --sprites` to also cache artwork into
`public/sprites/` so the app runs fully offline.

Current roster: **247 tradable assets** (231 species + 17 regional forms), carrying **81 Mega
Evolutions** and 66 alternate forms.

### What a "Pokémon" is here

The tradable unit is the **species, or a permanent regional form**. Alolan Ninetales is a
separate asset from Ninetales; Mega Charizard X and Y are *not* separate assets — owning
Charizard grants both, and raises its price accordingly. In-battle forms (Rotom's appliances,
Palafin's Hero form) come with the species too.

### Pricing

Price comes from **competitive tier**, not raw stats — Incineroar is a top doubles Pokémon on
utility rather than numbers, and any stat-derived price would badly underrate it. Base stats only
spread Pokémon out *within* a tier so the market isn't full of identical price tags.

| Tier | Price | Count |
|---|---|---|
| S | ₽316,000 – ₽400,000 | 11 |
| A+ | ₽180,000 – ₽250,000 | 15 |
| A | ₽104,000 – ₽140,000 | 14 |
| B | ₽42,000 – ₽77,000 | 15 |
| C | ₽20,000 – ₽34,000 | 14 |
| D | ₽4,000 – ₽8,000 | 13 |
| UR | ₽1,000 – ₽10,000 | 165 |

The scale is deliberately steep against the ₽300,000 opening budget: an S-tier costs more than
a whole starting balance, so early on the choice is a good squad or nearly one star, and the top
of the market only opens up to a club that keeps winning.

`UR` means the tier list doesn't rank it — that's *missing data*, not proof it's weak, so
unranked Pokémon are priced on base stats across a wide band. Otherwise Palafin (650 BST once it
transforms, unranked) would be free money.

**Tiers are for DOUBLES (VGC)**, since that's how Champions is played. This matters enormously:
Incineroar is S in doubles and mid-table in singles, and Hisuian Samurott is the reverse. To run
a singles league, replace the lists in `data/tiers.json` — nothing else changes.

### Tuning the economy

Two levers, in order of how often you'll reach for them:

1. **`data/tiers.json`** — move a Pokémon between tiers. This is the main balance dial, and your
   house rules beat any public tier list.
2. **`config/economy.ts`** — `TIER_PRICE_BANDS` sets what each tier costs, `VALUE_RULES` how value
   moves once a Pokémon is yours, and `LEAGUE_DEFAULTS` the budget and squad limits.
3. **`config/scoring.ts`** — `PAYOUTS.winReward` is what a win pays in each ladder tier, and
   `streakMultipliers` how a run compounds it.

Shop prices are fixed; a Pokémon's *value* is discovered by playing it.

### When the roster rotates

Champions rotates its legal roster by regulation. Re-run `npm run roster:build` and review the
diff. The script is deliberately loud:

- A Pokémon that can't be resolved on PokéAPI **fails the build** — a Pokémon vanishing silently
  from the league is worse than a broken build.
- A form that can't be attached to any asset **fails the build**.
- A Mega that PokéAPI hasn't catalogued yet (Champions ships Legends: Z-A Megas ahead of PokéAPI)
  **warns** and infers BST as base + 100, which is exact for every Mega.
- A tier-list name matching nothing **warns**, so a typo can't quietly make a Pokémon cheap for a
  whole season.

Two flags come off the source's availability column, and they mean different things:

- **`legal`** — on the Champions roster at all. Only a roster rotation sets this false, and a
  Pokémon that goes illegal is flagged rather than deleted, since a league may already own it.
- **`restricted`** — on the roster, but you can't catch one: transfer-only or event-only. Today
  that's exactly one Pokémon, **Eternal Flower Floette** (A+, ₽99,000, carries an S-tier Mega
  Floette). It's signable by default — results are self-reported anyway, so whether you have one
  to battle with is between you and your save file. Set `allowTransferOnly: 0` in a league's
  config for a catchable-only league; it then shows in the market with its caveat but can't be
  signed.

`npm run db:seed` also backfills: any Pokémon the catalog gains after a league was created is
added to that league as a free agent, so a roster refresh reaches a league already in progress.

## How the league works

**The table is the ladder.** Everyone plays the public ranked ladder separately, so position is
your Champions rank — Poké Ball → Great Ball → Ultra Ball → Master Ball → Champion. Within a tier
you climb ranks 4 → 1, each with a progress gauge that differs by tier (Poké Ball 3, Great Ball
4, Ultra Ball 5). At Master Ball it switches to a rating and a global placement, e.g.
*Master Ball 4 · 1,703.462 pts · top 123,329*.

You **report your own rank**; the game is the authority and the app just records it. Reaching a
new rank pays a promotion bonus — the first rank you enter is taken as your starting position,
so joining already in Ultra Ball isn't a payday.

**Unequal play is expected.** One player might log 40 matches in a week and another 5. So:

- Position comes from *rank*, not from accumulated points, and grinding doesn't inflate it.
- Only the first **10 matches per round** pay out. Beyond that, matches still count toward your
  rank and toward your Pokémon's form — they just stop paying, so nobody can simply out-grind
  the league and buy the market.

## Money, and what a Pokémon is worth

Money is only ever for signing Pokémon. There are no wages, no upkeep and no taxes — the one
thing that pays is **winning**, and how much depends on where you won it:

| Ladder tier | A win pays |
|---|---|
| Beginner · Poké Ball | ₽1,000 |
| Great Ball | ₽2,000 |
| Ultra Ball | ₽10,000 |
| Master Ball | ₽25,000 |
| Champion | ₽100,000 |

A winning run multiplies that: **×3 from your third straight win, ×5 from the fifth**. A loss pays
nothing at all — it never costs you money either. Promotions pay their bonus on top, once.

A Pokémon's **value** is separate from its shop price, and it is what you get back if you release
it:

- **Signing costs the full shop price, and the Pokémon is then worth 45% of it.** Signing and
  flipping loses money; a squad is a commitment, not a portfolio.
- **Every match it plays moves it**, by a percentage set by the ladder tier the match was in:
  Poké Ball +3/−3, Great Ball +4/−3, Ultra Ball +5/−2, Master Ball +6/−2. Winning low barely
  helps and losing low hurts; at the top it's the other way round. Pokémon you brought but never
  sent out don't move.
- Value never falls below ₽1,000, and deleting a match takes back exactly what it moved.

## Your squad, your six, your four

Three sizes, and they all matter:

| | Size | What it is |
|---|---|---|
| **Squad** | up to 12 | Everything you own. |
| **Starting lineup** | 6 | The Pokémon that are match-eligible. Set on the **Club** page. |
| **Brought to a match** | 4 | Who you actually took into the game you're reporting. |

Only a starter can appear in a reported match, which is what stops a deep squad being a free
upgrade — signing a twelfth Pokémon means benching one of your six. A squad with no lineup set
gets its six most valuable promoted automatically, so the rule is never a gate: you can draft and
report a match without ever visiting the club page. Selling or trading a Pokémon frees its slot.

On the **Club** page you drag cards between the lineup and the bench, and drag them around to set
the order they line up in — drop a substitute onto a starter and the two swap. Every card also
has a **Bench**/**Start** button, because a drag is hard work on a phone, and the board is
keyboard-operable. The same page holds your crest, your captain and the club honours.

Reporting a match is: tap **Won** or **Lost**, tap the four you brought, set their KOs, mark who
went down. The scoreline is derived from that — KOs you landed against Pokémon of yours that
fainted — because a doubles match ends when one side is out of Pokémon, so asking for a score
separately is asking twice for the same information.

**Running out of money is a real outcome.** Spend everything on one or two stars in the draft and
you'll skip your remaining picks and play with a tiny squad. That's allowed: the draft auto-skips
anyone who can't afford what's left, and the commissioner can end it early. There are no wages or
upkeep, so nothing bleeds you — but nothing tops you up either until you start winning.

## How ownership works

This is the part worth understanding, because it's the league's one hard rule.

When a league is created, an `Ownership` row is written for **every** legal Pokémon with
`teamId = null`. Acquiring one is then a *guarded* update — "change the owner from nobody to me"
— rather than a read, a decision, and a write:

```sql
UPDATE Ownership SET teamId = :me
 WHERE leagueId = :league AND pokemonSlug = :slug AND teamId IS NULL
```

If someone beat you to it, that matches zero rows and you're told you lost the race. Two people
really do click at the same instant during a draft. Backing it up, `@@unique([leagueId,
pokemonSlug])` means a Pokémon can only ever have one row in a league.

Every acquisition path — draft, market, trade, auction, waiver — goes through
`lib/services/ownership.ts`, and nothing else is allowed to write `Ownership.teamId`.

Money works the same way: `Team.cash` is a cache, the `Transaction` ledger is the truth, and
`verifyLedger()` asserts they agree. Debits are guarded on `cash >= amount` inside the UPDATE, so
two concurrent purchases can't both see enough money.

## The draft

Snake order, randomised, and teams **pay the shop price** for each pick. Paying during the draft
is what makes the budget bite from pick one — otherwise the best Pokémon would be handed out free
and the economy wouldn't start until the first trade.

## Playing solo

A league of one works. The draft becomes picking your own squad, and every match is logged
against an outside opponent — which is also how you record ladder matches in a group league,
since you're playing strangers, not each other.

## Layout

```
config/economy.ts          tiers, price bands, league defaults, value rules
config/crest.ts            crest shapes, glyphs and kit colours
data/roster.json           generated catalog (committed)
data/roster.csv            same data, hand-editable
data/tiers.json            competitive tiers — the balance lever
data/ranks.json            the Champions ladder: tiers, gauges, promotion bonuses
data/events.json           the random-event deck (parked until events return as decisions)
config/scoring.ts          points per KO/faint, win rewards by tier, streak multipliers
lib/ladder.ts              rank ordering, formatting, gauge maths
lib/roster/parse.ts        Bulbapedia wikitext parser (pure, tested)
lib/roster/tiers.ts        tier-name → roster-slug resolution
lib/services/ownership.ts  the only thing that may change who owns what
lib/services/money.ts      the ledger
lib/services/draft.ts      snake order and pick handling
lib/services/league.ts     creation, joining, invite codes
prisma/schema.prisma       data model
scripts/build-roster.ts    the roster pipeline
scripts/seed.ts            roster.json -> database
app/                       Next.js App Router pages
```

## Tests

```bash
npm test
```

127 tests. The ones that matter: four teams racing for the same Pokémon and exactly one winning
*and only that one being charged*; the ledger balancing after a run of buys and sells; a win
streak paying ₽10,000 → ₽30,000 → ₽50,000 and a deleted match giving all of it back along with
the value it moved; the snake order reversing; and the ladder comparing gauges as fractions,
since a tier's gauge size varies.

Integration tests build a throwaway SQLite database with a small fixed catalog, so they fail when
the logic breaks rather than when Garchomp changes tier.

### A note on running it

`npm run dev` and `npm run build` both wipe `.next` first, on purpose. The two share that
directory, and mixing them leaves a build whose HTML asks for dev-only asset URLs — every script
404s, the page renders, and nothing on it is clickable. If the app ever looks dead, check you
don't have a second server already holding port 3000.

## Build order

- [x] **Roster pipeline.** Catalog, doubles tiers, pricing.
- [x] **Foundations.** Auth, invite codes, leagues, teams, snake draft with auto-skip.
- [x] **Economy.** Market buy/sell, trades, ledger, value that moves with results.
- [x] **Competition.** Ladder ranks, match logging, per-Pokémon scoring, streak rewards with a cap.
- [x] **The club.** Crests, the squad board, honours, per-Pokémon stats, promotion bonuses.
- [ ] **Later.** Seasons and playoffs, contract expiry, auctions, FAAB waivers, value charts.

## Data sources

Roster and stats are community/fan resources; Pokémon and Pokémon Champions are trademarks of
Nintendo / Creatures Inc. / GAME FREAK. This is a private tool for tracking a friends' league.
