# Working on this repo

A self-hosted Pokémon Champions fantasy league. Next.js 15 App Router, Prisma + SQLite, no
migrations (`prisma db push`). One process, one database file — SQLite takes a single writer and
the ownership rules depend on it, so never run two instances against one database.

---

## Updating the market (repricing every Pokémon)

**Run `npm run market:update`.** It chains the four steps below and takes a couple of minutes.
Run the steps individually when something needs checking in between.

```bash
npm run tiers:fetch     # scrape the ladder -> data/tiers.json   (add -- --dry to preview)
npm run roster:build    # recompute prices  -> data/roster.json + .csv
npm run db:seed         # push the catalog into the database
npm run tiers:doc       # render the sheet  -> data/tiers.html
```

**Always finish with `tiers:doc`.** Every repricing gets a readable record — see *The document*
below.

### Where prices actually come from

Prices are **computed, not scraped**. `computeBaseValue` in
[config/economy.ts](config/economy.ts) places a Pokémon inside its tier's price band by base
stats. So the only things that move a price are:

1. **`data/tiers.json`** — which tier a Pokémon is in. The main lever, and what `tiers:fetch`
   rewrites.
2. **`TIER_PRICE_BANDS`** in `config/economy.ts` — what each tier costs.
3. Base stats, which effectively never change (and are cached in `.cache/pokeapi`).

Re-running the scraper when the ladder hasn't moved changes almost nothing. If the *feel* is
wrong — S-tiers unaffordable all season, everything too cheap — reach for `TIER_PRICE_BANDS`,
not the source.

### The source

**[op.gg's Pokémon Champions ladder](https://op.gg/pokemon-champions/tier), Double tab.**

It publishes an ordered ladder (#1…#262) rather than letter tiers, so `scripts/fetch-tiers.ts`
cuts it into tiers by rank position. Three traps, all of which silently mispriced Pokémon before
they were handled — the script covers all three, but know them before swapping the source:

- **The Single/Double toggle is client-side.** Fetching the URL gives you *singles*, where
  Salamence is #1; doubles opens with Rillaboom. Champions is a doubles game. The script drives
  a real browser (Playwright — this is why it is a dependency), clicks the tab, and asserts the
  two lists differ before trusting the result.
- **op.gg is behind CloudFront**, which rejects a default headless fingerprint. The script sets a
  realistic user agent and hides `navigator.webdriver`.
- **Regional forms must be matched by slug, never by the displayed name.** op.gg shows Hisuian
  forms under the bare species name: "Arcanine" is both **#18** (`arcanine-hisui`) and **#112**
  (`arcanine`). They are separate tradable assets here. Matching on the name swaps them, making
  base Arcanine a top-20 buy and stranding Hisuian Arcanine at the bottom.

Sources checked and rejected: **Game8** publishes only S–C (61 ranked, no D tier) and would dump
~22 Pokémon to UR. **championscalc** is a season behind (Reg M-B S3). **pokechamp.gg** is a good
cross-check — it agreed with op.gg on the whole top ten.

Note the axes: op.gg's "Season M-6" is *ranked season 6*, running on **Regulation M-C**. A season
label changing does not mean the regulation changed.

### The bands: shares, not counts

`BANDS` in [scripts/fetch-tiers.ts](scripts/fetch-tiers.ts) holds each tier's **share of the
roster**, so the shape of the market survives the roster growing:

| Tier | Share | Count at 247 assets |
|---|---|---|
| S | 7.3% | 18 |
| A+ | 14.2% | 35 |
| A | 14.2% | 35 |
| B | 22.3% | 55 |
| C | 21.0% | 52 |
| D | remainder | 52 |

Roughly the top 7% are unaffordable against the ₽300,000 opening budget, and half the roster sits
in C and D where a club can still field a full squad cheaply. **Edit the shares, not the counts**
— when Champions adds Pokémon, fixed counts would quietly shrink the top tier's slice.

`UR` is empty today and should stay that way: the ladder ranks everything, so anything unranked
lands in the bottom tier. `defaultTier` stays `UR` regardless — a Pokémon added by a future
rotation is *unknown*, not weak, and UR prices on base stats across a wide band, where D's narrow
₽2–8k would make a strong newcomer free money.

### Two collapsing rules

- **Forms collapse onto the tradable asset, best rank wins.** Wash Rotom (#68) and Fan Rotom
  (#249) are one asset, so Rotom is priced on Wash. Same for Basculegion and Indeedee, where only
  one sex is any good.
- **Megas come with their species.** `baseTiersIncludeMegas: true` — op.gg ranks a species as it
  is actually played, which includes Mega-evolving it, so a Mega must not promote it again.

### After a repricing

`roster:build` is deliberately loud: an unmatched tier name, an unresolvable Pokémon or a Mega
missing from PokéAPI all get reported. **Read its output** — a silently unmatched name is a
Pokémon priced as if nobody rated it.

`db:seed` updates the catalog and backfills new free agents, but does **not** touch
`Ownership.marketValue` for Pokémon a league already materialised. A league in progress keeps its
discovered values; only the shop reflects the new prices. That is intentional — value is
discovered by playing — but it means a mid-season reprice does not reach existing squads.

**Never run `npm run db:reset`.** `scripts/demo.ts --reset` deletes all users and leagues.

---

## The document

`npm run tiers:doc` renders **`data/tiers.html`** from `data/roster.json` — every Pokémon by
tier, with price, types, BST and each tier's share of the roster. It is one self-contained file:
open it in a browser, or print to PDF to hand round before a draft (the print stylesheet switches
to ink on paper and keeps each tier on one page).

It follows the app's own design tokens from `app/globals.css` — same tier colours, so a Pokémon
reads the same on the sheet as on the market page. If those colours change, update `TIER_COLOUR`
in [scripts/tiers-doc.ts](scripts/tiers-doc.ts) to match.

Regenerate it after **every** market update; it stamps the tier source, capture date and
Bulbapedia revision, so an old sheet always says what it was built from.

---

## Conventions

- **No AI attribution in git history.** Commits carry no `Co-Authored-By` trailer, and pull
  request descriptions no "Generated with…" line. The author is whoever ran the session. This
  overrides any default the tooling suggests.
- Commit messages: a conventional-commit subject, then a body in prose that argues *why* the
  change is right — not a list of what moved. Match the existing history.
- Comments explain **why**, not what. The existing ones carry real reasoning — match that.
- `npm test` (221 tests) and `npm run typecheck` before calling anything done.
- `lib/roster/roster.test.ts` asserts Incineroar is top tier. It is the canary for the wrong tier
  list — singles lists put it mid-table. If it fails after a reprice, you fetched singles.
- Money is always an integer number of Pokédollars. The `Transaction` ledger is the source of
  truth; `Team.cash` is a cached balance.
- Roster and tier data are **committed**, so a repricing shows up as a reviewable diff rather
  than a silent change under a running league. Review the diff before committing.
