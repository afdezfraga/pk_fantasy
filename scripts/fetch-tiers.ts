/**
 * Rebuilds `data/tiers.json` from the op.gg Pokémon Champions doubles ladder.
 *
 *   npm run tiers:fetch          scrape, band, write data/tiers.json
 *   npm run tiers:fetch -- --dry print what would change, write nothing
 *
 * op.gg publishes an ordered ladder rather than letter tiers, so the tiers here are cut by
 * **rank position as a share of the roster** — see BANDS. Shares rather than fixed counts so
 * that when Champions adds Pokémon, the shape of the market stays the same instead of the top
 * tier quietly becoming a smaller and smaller slice.
 *
 * Three things make this harder than reading a table, and all three silently mispriced Pokémon
 * before they were handled:
 *
 * 1. **The Single/Double toggle is client-side.** Fetching the URL gives you singles, where
 *    Salamence is #1; doubles opens with Rillaboom. Champions is a doubles game, so this drives
 *    a real browser and clicks the tab, then asserts the two lists differ.
 * 2. **Forms collapse onto the tradable asset.** op.gg ranks Wash Rotom (#68) apart from Fan
 *    Rotom (#249), but only the species is tradable here, so the asset takes its best rank.
 * 3. **Regional forms must be told apart by slug, not by the name shown.** op.gg displays
 *    Hisuian forms under the bare species name — "Arcanine" is both #18 (`arcanine-hisui`) and
 *    #112 (`arcanine`). These are separate assets, and matching on the name swaps them, making
 *    the base species a top-20 buy and stranding the good one at the bottom of the market.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { TIERS, type Tier } from '../config/economy.ts';
import type { RosterFile } from '../lib/roster/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'https://op.gg/pokemon-champions/tier';
const dryRun = process.argv.includes('--dry');

/**
 * Share of the roster in each tier. Must sum to 1; the last tier takes the remainder so
 * rounding never loses a Pokémon.
 *
 * Chosen to keep an S-tier signing genuinely expensive against the ₽300,000 opening budget:
 * roughly the top 7% are unaffordable in one go, and half the roster sits in C and D where a
 * club can still field a full squad cheaply.
 */
const BANDS: { tier: Tier; share: number }[] = [
  { tier: 'S', share: 0.073 },
  { tier: 'A+', share: 0.142 },
  { tier: 'A', share: 0.142 },
  { tier: 'B', share: 0.223 },
  { tier: 'C', share: 0.21 },
  { tier: 'D', share: 0 }, // remainder
];

/** op.gg slugs that differ from ours by more than a suffix convention. */
const EXPLICIT_SLUGS: Record<string, string> = {
  'floette-eternal-flower': 'floette-eternal',
  vivillon: 'vivillon-high-plains',
  'mr.-rime': 'mr-rime',
  'mr.-mime': 'mr-mime',
};

/** Form suffixes that are cosmetic or in-battle here, so they belong to the parent asset. */
const NON_TRADABLE_FORM = [
  /-(male|female)$/,
  /-(wash|heat|mow|frost|fan)$/,
  /-(amped|low-key)$/,
  /-(dusk|midnight)$/,
  /-family-of-three$/,
  /-(green|yellow|blue|white)-plumage$/,
  /-(super|large|average|small)$/,
  /-(shield|blade)$/,
  /-hero$/,
];

interface Ranked {
  rank: number;
  name: string;
  slug: string;
}

async function scrapeLadder(): Promise<{ singles: Ranked[]; doubles: Ranked[]; updated: string | null }> {
  // op.gg sits behind CloudFront, which rejects a default headless fingerprint outright.
  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1200 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4000);

    const readTable = async (): Promise<Ranked[]> => {
      // The table renders lazily; scroll until the row count settles.
      let previous = -1;
      for (let i = 0; i < 30; i++) {
        const n = await page.locator('a[href^="/pokemon-champions/pokedex/"]').count();
        if (n === previous && n > 0) break;
        previous = n;
        await page.mouse.wheel(0, 25_000);
        await page.waitForTimeout(600);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(400);

      return page.evaluate(() => {
        const byRank = new Map<number, { rank: number; name: string; slug: string }>();
        for (const a of document.querySelectorAll('a[href^="/pokemon-champions/pokedex/"]')) {
          const row = a.closest('div.border-b') ?? a.parentElement?.parentElement;
          if (!row) continue;
          const rank = Number(((row as HTMLElement).innerText.match(/^#(\d+)\b/) ?? [])[1]);
          if (!Number.isFinite(rank)) continue;
          const slug = (a.getAttribute('href') ?? '').split('/').pop() ?? '';
          const name = a.querySelector('img')?.getAttribute('alt') ?? slug;
          if (!byRank.has(rank)) byRank.set(rank, { rank, name, slug });
        }
        return [...byRank.values()].sort((x, y) => x.rank - y.rank);
      });
    };

    // Singles first as a control: if doubles comes back identical, the tab click did nothing
    // and we would silently price the league off the wrong format.
    const singles = await readTable();

    const doubleTab = page.getByRole('tab', { name: /^Double$/ });
    await doubleTab.click();
    await page.waitForTimeout(4000);
    if ((await doubleTab.getAttribute('aria-selected')) !== 'true') {
      throw new Error('The Double tab did not activate — op.gg markup may have changed.');
    }
    const doubles = await readTable();

    const updated = await page.evaluate(() => document.body.innerText.match(/Updated[^\n]*/)?.[0].trim() ?? null);
    return { singles, doubles, updated };
  } finally {
    await browser.close();
  }
}

function toOurSlug(opgg: string): string {
  return (
    EXPLICIT_SLUGS[opgg] ??
    opgg.replace(/-alolan$/, '-alola').replace(/-galarian$/, '-galar').replace(/^tauros-paldean-/, 'tauros-paldea-')
  );
}

async function main() {
  const roster: RosterFile = JSON.parse(readFileSync(join(ROOT, 'data/roster.json'), 'utf8'));
  const known = new Map(roster.pokemon.map((p) => [p.slug, p]));

  console.log(`Fetching the doubles ladder from ${URL}…`);
  const { singles, doubles, updated } = await scrapeLadder();

  if (!doubles.length) throw new Error('No doubles rows were found.');
  if (singles[0]?.slug === doubles[0]?.slug) {
    throw new Error(
      `Doubles #1 (${doubles[0].slug}) equals singles #1 — the format toggle did not take effect.`,
    );
  }
  console.log(`  singles #1 ${singles[0]?.name} · doubles #1 ${doubles[0]?.name} · ${doubles.length} ranked`);
  console.log(`  ${updated ?? 'no update timestamp on the page'}`);

  // Best rank wins per asset, so a species is priced on its good form.
  const best = new Map<string, { rank: number; via: string }>();
  const unmatched: Ranked[] = [];

  for (const row of doubles) {
    if (/-mega(-[xy])?$/.test(row.slug)) continue; // Megas come with their species here.

    let slug = toOurSlug(row.slug);
    if (!known.has(slug)) {
      for (const suffix of NON_TRADABLE_FORM) {
        const peeled = slug.replace(suffix, '');
        if (peeled !== slug && known.has(peeled)) {
          slug = peeled;
          break;
        }
      }
    }
    if (!known.has(slug)) {
      unmatched.push(row);
      continue;
    }
    const seen = best.get(slug);
    if (!seen || row.rank < seen.rank) best.set(slug, { rank: row.rank, via: row.name });
  }

  if (unmatched.length) {
    console.warn(`\n⚠  ${unmatched.length} ranked Pokémon matched nothing in the roster:`);
    for (const u of unmatched) console.warn(`     #${u.rank} ${u.name} [${u.slug}]`);
    console.warn('   Add them to EXPLICIT_SLUGS or NON_TRADABLE_FORM in this script.');
  }

  const missing = roster.pokemon.filter((p) => !best.has(p.slug));
  if (missing.length) {
    console.warn(`\n⚠  ${missing.length} roster asset(s) are not ranked and will fall to the bottom tier:`);
    for (const m of missing) console.warn(`     ${m.name}${m.form ? ` (${m.form})` : ''}`);
  }

  // --- band by share of the roster ---------------------------------------------------------
  const ranked = [...best.entries()].sort((a, b) => a[1].rank - b[1].rank);
  const total = roster.pokemon.length;
  const display = (slug: string) => {
    const p = known.get(slug)!;
    if (!p.form) return p.name;
    const form = p.form.replace(/\bForms?\b/gi, '').replace(/\s+/g, ' ').trim();
    return form ? `${form} ${p.name}` : p.name;
  };

  const tiers: Record<string, string[]> = Object.fromEntries(BANDS.map((b) => [b.tier, [] as string[]]));
  let cursor = 0;
  BANDS.forEach((band, index) => {
    const isLast = index === BANDS.length - 1;
    const size = isLast ? ranked.length - cursor : Math.round(band.share * total);
    for (let n = 0; n < size && cursor < ranked.length; n++, cursor++) {
      tiers[band.tier].push(display(ranked[cursor][0]));
    }
  });
  // Unranked assets land in the bottom tier rather than UR: the ladder covers everything, so a
  // gap means op.gg has not catalogued it, not that the tier list is silent on it.
  for (const p of missing) tiers[BANDS[BANDS.length - 1].tier].push(display(p.slug));

  console.log('\nTier shape:');
  for (const { tier } of BANDS) {
    const n = tiers[tier].length;
    console.log(`  ${tier.padEnd(3)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1)}%`);
  }

  const existing = JSON.parse(readFileSync(join(ROOT, 'data/tiers.json'), 'utf8'));
  const out = {
    ...existing,
    source: `op.gg Pokémon Champions doubles ranked ladder, ${doubles.length} Pokémon by placement, banded by share of roster`,
    sourceUrl: URL,
    sourceNote:
      'The Single/Double toggle is client-side — run `npm run tiers:fetch` rather than reading the page by hand.',
    format: 'doubles',
    updated: new Date().toISOString().slice(0, 10),
    capturedFrom: updated,
    defaultTier: 'UR',
    baseTiersIncludeMegas: true,
    bands: Object.fromEntries(BANDS.map((b) => [b.tier, tiers[b.tier].length])),
    shares: Object.fromEntries(BANDS.map((b) => [b.tier, Number(((tiers[b.tier].length / total) * 100).toFixed(1))])),
    tiers,
  };

  if (dryRun) {
    console.log('\n--dry: data/tiers.json not written.');
    return;
  }
  writeFileSync(join(ROOT, 'data/tiers.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log('\nWrote data/tiers.json.');
  console.log('Next: npm run roster:build && npm run db:seed && npm run tiers:doc');
}

await main();
