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
> trades, ladder ranks, match reporting, streak rewards and random events all work. Solo play is
> supported.

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

On your own machine, `npm run build && npm run start` serves it properly. That's plain HTTP over
your LAN; session cookies are marked `secure` in production, so set `ALLOW_INSECURE_COOKIE=1` if
there's no TLS in front. All the league's data lives in `prisma/dev.db` — back that file up.

To reach it from anywhere, **[DEPLOY.md](DEPLOY.md)** puts it on a free Oracle Cloud VM with real
HTTPS in about an hour:

```bash
cp .env.deploy.example .env   # your DuckDNS subdomain
docker compose up -d --build
```

One SQLite file means one process and one disk — so a VM, not a serverless platform. DEPLOY.md
explains why, and what bites.

## The roster pipeline

`npm run roster:build` regenerates the league's Pokémon catalog from two sources:

| Source | Provides |
|---|---|
| [Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_in_Pok%C3%A9mon_Champions) (MediaWiki API) | Which Pokémon are legal in Champions, their forms, Megas, and when each was added |
| [PokéAPI](https://pokeapi.co/) | Base stats and official artwork |
| `data/tiers.json` (hand-maintained, banded from the [op.gg doubles ladder](https://op.gg/pokemon-champions/tier)) | Competitive tiers, which drive price |

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
| S | ₽316,000 – ₽400,000 | 18 |
| A+ | ₽178,000 – ₽250,000 | 35 |
| A | ₽92,000 – ₽136,000 | 35 |
| B | ₽40,000 – ₽80,000 | 55 |
| C | ₽10,000 – ₽33,000 | 52 |
| D | ₽2,000 – ₽8,000 | 52 |
| UR | ₽1,000 – ₽10,000 | 0 |

The scale is deliberately steep against the ₽300,000 opening budget: an S-tier costs more than
a whole starting balance, so early on the choice is a good squad or nearly one star, and the top
of the market only opens up to a club that keeps winning.

`UR` means the tier list doesn't rank it — that's *missing data*, not proof it's weak, so
unranked Pokémon are priced on base stats across a wide band. Otherwise Palafin (650 BST once it
transforms, unranked) would be free money. **It is empty today**: the current source ranks the
whole ladder, so every asset has a real tier. It stays as the landing place for a Pokémon that a
future roster rotation adds before the tier list catches up.

**Tiers are for DOUBLES (VGC)**, since that's how Champions is played. This matters enormously:
Incineroar is S in doubles and mid-table in singles, and Hisuian Samurott is the reverse. The
source ranks the two formats separately — Salamence is #1 in singles but #3 in doubles, where
Rillaboom leads — so a singles league just needs the other list in `data/tiers.json`; nothing
else changes.

Because the source publishes one ordered ladder rather than letter tiers, the tiers above are cut
by rank position (`bands` in `data/tiers.json`), as a **share of the roster** rather than a fixed
count — so the shape of the market survives Champions adding Pokémon. Two wrinkles are worth
knowing, since both were silently mispricing Pokémon before:

- **Forms collapse to the tradable asset, best rank wins.** Wash Rotom (#68) and Fan Rotom (#249)
  are one asset here, so Rotom is priced on Wash.
- **Regional forms must be told apart by slug, not display name.** op.gg shows Hisuian forms under
  the bare species name: "Arcanine" is both #18 (`arcanine-hisui`) and #112 (`arcanine`). They are
  separate assets, and matching on the name swaps them.

`npm run tiers:fetch` does all of this; `npm run market:update` chains it with the rebuild, the
reseed and the sheet below.

### The price sheet

`npm run tiers:doc` writes `data/tiers.html` — every Pokémon by tier with price, types and BST,
and each tier's share of the roster. One self-contained file: open it in a browser, or print to
PDF to hand round before a draft. Regenerate it after every repricing; it stamps the tier source,
the capture date and the Bulbapedia revision, so an old sheet always says what it was built from.

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

Everyone starts a season at **Poké Ball 4**, as the game does. You **report your rank with each
match result** — the form fills in where the result should leave you, and you check it against
the game, which is the authority. Reaching a new ball tier — Great, Ultra, Master, Champion — pays
a promotion bonus the first time you get there in a season; ranks inside a tier, and leaving
Beginner, pay nothing. One match can climb at most one tier, a loss can't promote you, and the
game never demotes a tier, so the app refuses those.

If the rank on file is simply wrong — you didn't start at Poké Ball 4, or a report got it wrong —
the rank panel's **Correct** button opens a dialog to set it by hand. A correction never pays a
bonus and doesn't count as reaching a tier, so a real climb afterwards still pays.

**Unequal play is expected.** One player might log 40 matches in a week and another 5. So:

- Position comes from *rank*, not from accumulated points, and grinding doesn't inflate it.
- Only the first **10 matches per round** pay out. Beyond that, matches still count toward your
  rank and toward your Pokémon's form — they just stop paying, so nobody can simply out-grind
  the league and buy the market.
- A round **closes by itself** once at least half the clubs have played those 10. The
  commissioner can also close it early.

## Seasons

The commissioner can end a season from the league page. Every club goes back to Poké Ball 4, and
every Pokémon except each club's **captain** is sold back to the market at its current value. The
league then waits in setup for a new draft — new players can join with the invite code in between
— and the captain is the one Pokémon a club carries from season to season.

A club always has a captain once it owns anything: the first Pokémon drafted takes the armband,
and if the captain is sold or traded, it passes to the longest-serving Pokémon left. You can hand
it to anyone in the squad, but not take it away.

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
nothing at all — it never costs you money either. Reaching a new ball tier pays ₽20,000 on top,
once a season per tier (set per tier in `data/ranks.json`).

A Pokémon's **value** is separate from its shop price, and it is what you get back if you release
it:

- **Signing costs the full shop price, and the Pokémon is then worth 45% of it.** Signing and
  flipping loses money; a squad is a commitment, not a portfolio.
- **Every match it plays moves it**, by a percentage set by the ladder tier the match was in:
  Poké Ball +3/−3, Great Ball +4/−3, Ultra Ball +5/−2, Master Ball and Champion +6/−2. Winning
  low barely helps and losing low hurts; at the top it's the other way round. Only the result
  counts — KOs and fainting score fantasy points, never value — and a Pokémon that stayed in the
  back isn't reported, so it doesn't move.
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

Reporting a match is: tap **Won** or **Lost**, tap the ones you sent out, set their KOs, mark who
went down, and confirm your rank after it. On a loss everyone you sent out counts as fainted,
because that's how a doubles match is lost. The scoreline is derived from that — KOs you landed against Pokémon of yours that
fainted — because a doubles match ends when one side is out of Pokémon, so asking for a score
separately is asking twice for the same information.

**Running out of money is a real outcome.** Spend everything on one or two stars in the draft and
you'll skip your remaining picks and play with a tiny squad. That's allowed: the draft auto-skips
anyone who can't afford what's left, and the commissioner can end it early. There are no wages or
upkeep, so nothing bleeds you — but nothing tops you up either until you start winning.

## Events

Every few matches something goes wrong at your club, and you decide what to do about it. **You
can't report another match until you have.** That's the whole shape of it: an event is a problem
with two or three answers, none of them free.

The best ones cost no money at all. A sulking star has to be run at zero EVs for five matches; the
pitch is being relaid so you can't set weather or terrain; the coach has a philosophy and you're
attacking with STAB moves only until they get over it. Those change how you actually play, which
is worth more than another number moving. A flight doesn't land and you take three into a match
instead of four, or drive everyone through the night and watch a fortnight of development go
nowhere. Somebody complains about how you play and you spend four matches without a protection
move.

Some ask something bigger. A club offers a straight swap for one of yours — take it and you get a
named Pokémon of the same standing, refuse and yours plays five matches with its training undone.
Recruitment offers two free agents for one of your best, and lets you pick which of your best. A
sponsor asks how many of your next five you think you'll win, and pays — or charges — on what you
said. The league wants your money locked away for two rounds at 15%.

**One lands the moment the draft ends**, before your first match, and then roughly every five
matches you report — jittered, so you can't count the timing and plan around it.

Closing a round draws one **league-wide** event instead: the same template, with its shared
details settled once, handed to every club at the same moment. Some of those are decisions each
club answers for itself; a change to the rules everybody plays under is not, and simply applies
— a regulation that hit Water-types hit Water-types everywhere, and a club does not get to opt
out of it.

### What the app can and can't check

The app never watches a battle, so consequences come in two kinds and it's honest about which:

- **Enforced.** "Charizard is out injured" — it's greyed out in the match picker and the report
  is refused. So are type bans, a shortened lineup — five names on the sheet instead of six,
  though you still take four into the match — transfer freezes, money and value. A freeze stops
  signings, sales and trades alike, and lifts when the round turns.
- **On your word.** "No Mega Evolution for four matches" — the app can't tell, so it asks. You
  tick a box when you report, and what you claimed is stored on the result and shown in the feed
  next to it. That's the same honour system the scoreline already runs on.

Anything you *agreed to* — a sponsor target, a league bond — is shown apart from the things done
to you, and a target counts up as you play: *"Sponsor target — 1 of 2 wins"*. A wager settles the
moment the answer is certain rather than when its window runs out, so a run you can no longer
rescue is called at the match it died, not three matches later.

Every answer goes into the league feed as it happens — which club, which branch, what it cost,
and whether it was left to the assistant — so a decision taken quietly is still a decision the
rest of the league can read.

Whatever's in force is shown on your club page, above the report form, and on every result it
affected — and when it ends you're told, in the league feed and on the page: *"Kangaskhan has been
cleared to play again."* A restriction you forget about is worse than no restriction.

### Nothing can lock you out

Because reporting is blocked, an event you can't answer would be a dead league. Four things stop
that:

- **Your assistant will handle it.** One click on nearly every event; they pick at random from
  whatever's open. It costs you control, not money, and it's always available.
- **A bill you can't pay puts you in the red.** Event charges are the only thing in the app that
  may push a balance negative. Debt is then its own punishment — you can't sign anyone until you've
  sold or won your way back into the black.
- **A ban never stops you fielding a match.** Down to fewer than four usable Pokémon, a barred one
  can still be reported — but only Pokémon that were sent out are reported, so that's a forfeit
  and the match is recorded as a loss. If it only came as cover, leave it off.
- **The commissioner can force one through**, and `eventsEnabled: 0` turns the system off.

### Writing your own

`data/events.json` is the deck, and adding to it needs no code — only `kind` is referenced by
name, and it must be one of the vocabulary in `lib/services/effects.ts`. `npm test` validates the
deck on every run and fails if a template has no option a broke club could click, if a percentage
cost has no floor, or if a lasting restriction doesn't say how it ends.
`npx tsx scripts/preview-events.ts` renders a template against a real club, which is the quickest
way to find out whether what you wrote reads like anything.

Two things worth knowing when you write one. An option marked `repeat: "@starters"` becomes one
option per Pokémon — *"Let Garchomp go"*, *"Let Ferrothorn go"* — spread across the squad by value,
which is how a club chooses *who* an event takes without a decision becoming more than a button.
And a win is worth ₽1,000 in the beginner tier and ₽100,000 in Champion, so money is priced in
win-rewards (`rewardWins`) or as a share of the balance (`pct` + `min`) rather than flat, or one
figure is pocket change to one club and a season's earnings to another.

Two dials in `config/economy.ts`: `eventEveryMin`/`eventEveryMax` for pacing, and `eventSeverity` for when a
season tells you the deck is too harsh — it scales what an option costs and how long its
consequences last, the two quantities that unambiguously mean "worse" when they're bigger. Value
percentages and one-off payments are left alone, since a scaler that can't tell a gain from a
loss would make some events kinder the harsher you set the league.

Upsetting the Pokémon the rest of the squad takes its lead from isn't a private matter. A template
can carry `severityMult: { captain: 1.5 }`, so the same event costs more and lasts longer when it
lands on your captain — and an effect can carry `spreadTo: "starters"`, which puts a milder copy
on two others. Refuse your captain's transfer request and three of your six are sulking, not one.
That's what makes choosing a captain a decision rather than a label.

Some events aren't random at all. Name a Pokémon in your six and then leave it out of ten matches
and it asks why; play the same four in all of your last ten and they burn out; make three market
moves in a round and nobody knows where anybody is meant to be; sit bottom of the table and a
backer nobody else would take a call from turns up. Those are drawn *ahead* of the deck — an event
you caused beats one that was rolled — and they name the Pokémon that actually caused them.

Both counts are measured from the Pokémon's own history, not the club's: a signing that arrived
yesterday hasn't been ignored for a season, however long the club has been going.

### Rounds are the clock

There are no fixtures and no dates worth trusting, so **the round is how the app tells time**.
A league is on round 1 from the moment it's created — through setup and the draft, and on into
play — so nothing ever happens outside a round. Every match, event, restriction, value move and
ledger entry records the round it happened in, which is what makes "what did this club do this
round" a question with an answer.

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
`lib/services/ownership.ts`, and nothing else is allowed to write `Ownership.teamId`. Events that
hand a Pokémon over need to release and sign inside one transaction, and SQLite won't nest one, so
`claimFreeAgent` and `releaseToMarket` are the same guarded writes taking a caller's transaction
rather than opening their own. `acquireFreeAgent` and `sellToMarket` are thin wrappers over them.

### The board

A **listing** is a Pokémon one club has put up at a fixed price, which any other club may simply
take — first to sign gets it. A `TradeOffer` names the club it's aimed at and has to be accepted;
a listing is public and needs nobody's agreement.

Anyone can put one of their own Pokémon up, from the **Market** page. Four rules make it a market
rather than a bluff:

- **The price is frozen when the listing opens** — its market value plus whatever premium put it
  there. A board whose prices move while you read it is not a board.
- **You choose how long it runs**, anywhere from an hour to a week, on the clock rather than on
  rounds. A round can close in an evening, and an offer half the league never saw is not an offer.
  An hour is a real tactic: put something up before tonight's matches and see if anyone bites.
- **You can take your own back whenever you like.** The seller picks the window, so anyone wanting
  to fish for interest can simply post for an hour — there is nothing left to protect by forcing a
  manager to watch their own squad be sold out from under them.
- **A Pokémon has one listing at a time**, and it dies with the ownership: sell it, trade it, or
  lose it to an event, and the listing comes straight off the board rather than advertising
  something its seller can no longer deliver.

**An event's listing is the exception.** When a decision puts a Pokémon up — *let it explore its
options* — that one runs the full five days and **cannot be withdrawn**. It outranks a listing you
had already posted for the same Pokémon, replacing your terms with its own: putting your own price
up is not a way to pre-empt what an event is about to do with it.

Nobody comes? It's still yours, it comes off the board on its own, and your club is told. The
sale itself is a transfer, not a trip through free agency: the Pokémon keeps its value and moves
straight from one squad to the other, arriving as a reserve so the new manager picks their own six.

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
data/events.json           the event deck — problems managers answer
lib/services/events.ts     drawing an event, and answering it
lib/services/effects.ts    what an event leaves behind, and how long it lasts
lib/services/triggers.ts   the club's situation, and what it's done to deserve an event
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
scripts/preview-events.ts  renders a template against a real club, for writing the deck
app/                       Next.js App Router pages
Dockerfile                 the deployed image: one process, one SQLite file
docker-compose.yml         the app plus Caddy for automatic HTTPS
deploy/entrypoint.sh       schema, WAL, seed-if-empty, then the server
deploy/backup.sh           nightly hot backup of the league
DEPLOY.md                  putting it on a free cloud VM
```

## Tests

```bash
npm test
```

221 tests. The ones that matter: four teams racing for the same Pokémon and exactly one winning
*and only that one being charged*; the ledger balancing after a run of buys and sells; a win
streak paying ₽10,000 → ₽30,000 → ₽50,000 and a deleted match giving all of it back along with
the value it moved; the snake order reversing; and the ladder comparing gauges as fractions,
since a tier's gauge size varies.

On the events side: that the deck can never offer a club nothing it can afford, since reporting
is blocked until an event is answered; that a club with ₽0 still gets to answer and lands in debt
rather than stranded; that two page loads arriving together draw exactly one event; that a banned
Pokémon is refused while there's cover, allowed benched when there isn't, and forfeits the match
if it plays; and that a restriction ends on exactly the match it said it would. Also that a swap
substitutes an equivalent when the Pokémon it named has been signed by somebody else in the
meantime, that a wager settles the instant its answer is certain, and that a frozen club can
neither sign, sell nor trade until the round turns, and that deleting a result gives a wager
back its match and its win together. And that a decision refused in front of the squad puts the
milder version in force on two others, each of which has to be confirmed before the club plays
again.

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
- [x] **Events.** Decisions with consequences, battle-rule restrictions, triggered events.
- [x] **Seasons.** Rounds that close themselves, season resets, captains carried over.
- [ ] **Later.** Playoffs, contract expiry, auctions, FAAB waivers, value charts.

## Data sources

Roster and stats are community/fan resources; Pokémon and Pokémon Champions are trademarks of
Nintendo / Creatures Inc. / GAME FREAK. This is a private tool for tracking a friends' league.
