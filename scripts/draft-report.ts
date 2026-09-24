/**
 * Renders the draft report as a PDF: the guide's findings written out as something to read
 * before draft night, rather than a board to scan on it.
 *
 *   npm run guide:report                 → reports/draft-report.pdf   (league edition)
 *   npm run guide:report -- --private    → private/scouting-report.pdf (your edition)
 *
 * The league edition explains the market and the roles to everyone. The private edition adds
 * a scouting section — a simulated draft, what the room will overpay for, and what slips —
 * plus whatever you have written in `private/scouting-notes.html`. Both output folders are
 * gitignored: the PDFs are rebuilt on every reprice, and the private one must never reach
 * history the rest of the league can read.
 *
 * Every number is read live from the roster, the economy config and the guide model, so the
 * prose can't go stale against the prices it describes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

import { LEAGUE_DEFAULTS, TIERS, TIER_PRICE_BANDS, VALUE_RULES, type Tier } from '../config/economy.ts';
import { PAYOUTS, SCORING } from '../config/scoring.ts';
import {
  BUDGET_CEILING,
  availableAt,
  medianWhenTaken,
  seededRandom,
  simulateDraft,
  takenShare,
  type SimResult,
} from '../lib/roster/draft-guide.ts';
import { FONT_LINKS, TIER_COLOUR, escape, money, moneyShort } from './doc-kit.ts';
import { ROOT, loadGuide, type Category, type GuideModel, type ScoredMon } from './guide-model.ts';

const PRIVATE = process.argv.includes('--private');
const fmt = (n: number) => n.toFixed(1);
const pct = (n: number) => `${Math.round(n * 100)}%`;

// --- small pieces ---------------------------------------------------------------------------

function chip(tier: Tier): string {
  return `<span class="chip" style="--tier:${TIER_COLOUR[tier]}">${escape(tier)}</span>`;
}

function monCell(m: ScoredMon): string {
  return `<span class="mon">${m.iconUrl ? `<img src="${escape(m.iconUrl)}" alt="" width="28" height="28">` : ''}${escape(m.name)}</span>`;
}

function draftable(m: ScoredMon): boolean {
  return m.pick !== null;
}

// --- the price chart ------------------------------------------------------------------------

/**
 * Price against ladder rank, log scale, one dot per Pokémon. The tiers are contiguous runs of
 * rank, so they are shown as labelled bands rather than colours — the shape to see is the
 * staircase: flat inside a tier, a cliff at every boundary. A handful of the guide's bargains
 * are called out, because the chart exists to show where they come from.
 */
function priceChart(model: GuideModel, callouts: string[]): string {
  const W = 720;
  const H = 300;
  const pad = { l: 58, r: 12, t: 26, b: 34 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const mons = [...model.mons].sort((a, b) => a.rank - b.rank);
  const maxRank = mons.length;
  const lo = Math.log10(1_000);
  const hi = Math.log10(500_000);
  const x = (rank: number) => pad.l + ((rank - 1) / (maxRank - 1)) * iw;
  const y = (price: number) => pad.t + ih - ((Math.log10(price) - lo) / (hi - lo)) * ih;

  const bands = TIERS.filter((t) => mons.some((m) => m.tier === t))
    .map((tier, i) => {
      const inTier = mons.filter((m) => m.tier === tier);
      const x0 = x(inTier[0].rank - 0.5);
      const x1 = x(inTier[inTier.length - 1].rank + 0.5);
      const shade = i % 2 === 0 ? '<rect class="band" x="' + x0.toFixed(1) + '" y="' + pad.t + '" width="' + (x1 - x0).toFixed(1) + '" height="' + ih + '"/>' : '';
      return `${shade}
        <rect x="${x0.toFixed(1)}" y="${pad.t - 10}" width="${(x1 - x0).toFixed(1)}" height="4" rx="2" fill="${TIER_COLOUR[tier]}"/>
        <text class="band-label" x="${((x0 + x1) / 2).toFixed(1)}" y="${pad.t - 14}">${escape(tier)}</text>`;
    })
    .join('');

  const ticks = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000]
    .map(
      (v) => `
        <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
        <text class="tick" x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${moneyShort(v)}</text>`,
    )
    .join('');
  const budgetLine = `
        <line class="budget" x1="${pad.l}" x2="${W - pad.r}" y1="${y(model.budget).toFixed(1)}" y2="${y(model.budget).toFixed(1)}"/>
        <text class="budget-label" x="${W - pad.r}" y="${(y(model.budget) - 6).toFixed(1)}" text-anchor="end">Opening budget ${moneyShort(model.budget)}</text>`;

  const highlighted = new Set(callouts);
  const dots = mons
    .filter((m) => !highlighted.has(m.slug))
    .map((m) => `<circle class="dot" cx="${x(m.rank).toFixed(1)}" cy="${y(m.price).toFixed(1)}" r="3"/>`)
    .join('');
  const hot = mons
    .filter((m) => highlighted.has(m.slug))
    .map((m, i) => {
      const cx = x(m.rank);
      const cy = y(m.price);
      const dy = i % 2 === 0 ? -12 : 20;
      return `<circle class="hot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5"/>
        <text class="hot-label" x="${cx.toFixed(1)}" y="${(cy + dy).toFixed(1)}" text-anchor="middle">${escape(m.name)}</text>`;
    })
    .join('');

  return `
  <figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Shop price against doubles ladder rank for every Pokémon, log scale. Prices are flat within each tier and drop sharply at every tier boundary.">
      ${bands}
      ${ticks}
      ${budgetLine}
      ${dots}
      ${hot}
      <text class="axis" x="${pad.l + iw / 2}" y="${H - 6}" text-anchor="middle">op.gg doubles ladder rank → (#1 left, #${maxRank} right)</text>
    </svg>
    <figcaption>
      <span class="key"><span class="k-dot"></span>Every Pokémon</span>
      <span class="key"><span class="k-hot"></span>Best Pick in each tier</span>
      Price on a log scale. Within a tier, price follows base stats, so a highly ranked Pokémon near
      the top of its tier can cost the same as one near the bottom.
    </figcaption>
  </figure>`;
}

// --- sections -------------------------------------------------------------------------------

/** The last Pokémon of each tier against the first of the next: the cliffs. */
function cliffs(model: GuideModel) {
  const mons = [...model.mons].sort((a, b) => a.rank - b.rank);
  const out: { above: ScoredMon; below: ScoredMon }[] = [];
  for (let i = 0; i < mons.length - 1; i += 1) {
    if (mons[i].tier !== mons[i + 1].tier) out.push({ above: mons[i], below: mons[i + 1] });
  }
  return out;
}

function bestDraftable(category: Category): ScoredMon | null {
  return category.cards.find((c) => draftable(c.mon))?.mon ?? null;
}

function bestBudget(category: Category): ScoredMon | null {
  const carded = category.cards.find((c) => c.mon.price <= BUDGET_CEILING)?.mon;
  if (carded) return carded;
  return category.others.find((o) => o.mon.price <= BUDGET_CEILING)?.mon ?? null;
}

function roleRow(category: Category): string {
  const top = category.cards[0]?.mon ?? null;
  const draft = bestDraftable(category);
  const cheap = bestBudget(category);
  const cell = (m: ScoredMon | null) =>
    m ? `${monCell(m)} ${chip(m.tier)} <span class="price">${moneyShort(m.price)}</span>` : '<span class="none">—</span>';
  return `
    <article class="role">
      <header><p class="kicker">${escape(category.kicker)}</p><h3>${escape(category.title)}</h3></header>
      <p>${escape(category.why)}</p>
      <dl class="role-picks">
        <div><dt>Best there is</dt><dd>${cell(top)}</dd></div>
        <div><dt>Best you can draft</dt><dd>${cell(draft)}</dd></div>
        <div><dt>Best under ${moneyShort(BUDGET_CEILING)}</dt><dd>${cell(cheap)}</dd></div>
      </dl>
    </article>`;
}

function boardTable(model: GuideModel, rows: ScoredMon[], extra?: (m: ScoredMon) => string, extraHead?: string): string {
  return `
  <table class="data">
    <thead><tr><th>#</th><th>Pokémon</th><th>Tier</th><th class="r">Price</th><th class="r">Power</th><th class="r">Value</th><th class="r">Pick</th>${extraHead ? `<th>${extraHead}</th>` : ''}</tr></thead>
    <tbody>${rows
      .map(
        (m, i) => `
      <tr>
        <td class="muted">${i + 1}</td>
        <td>${monCell(m)}</td>
        <td>${chip(m.tier)}</td>
        <td class="r">${moneyShort(m.price)}</td>
        <td class="r">${fmt(m.power)}</td>
        <td class="r">${fmt(m.value)}</td>
        <td class="r strong">${m.pick === null ? '—' : fmt(m.pick)}</td>
        ${extra ? `<td>${extra(m)}</td>` : ''}
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function squadsSection(model: GuideModel): string {
  return model.squads
    .map(
      (s) => `
    <article class="squad">
      <h3>${escape(s.name)} <span class="muted">· ${money(s.total)} of ${money(model.budget)}</span></h3>
      <p>${escape(s.idea)}</p>
      <ul>${s.members
        .map(
          (m) =>
            `<li>${monCell(m)} ${chip(m.tier)} <span class="price">${moneyShort(m.price)}</span>${m.slug === s.mega ? ' <span class="mega">Mega</span>' : ''}</li>`,
        )
        .join('')}</ul>
    </article>`,
    )
    .join('');
}

// --- private: the economics of saving up ------------------------------------------------------

/**
 * Average money per paid match at a given win rate, in a ladder tier, streaks included.
 * Simulated rather than solved, because the streak multiplier makes the closed form ugly and a
 * few hundred thousand coin flips are instant.
 */
function earningsPerMatch(tierKey: string, winRate: number): number {
  const random = seededRandom(7);
  const reward = PAYOUTS.winReward[tierKey] ?? 0;
  let streak = 0;
  let total = 0;
  const n = 200_000;
  for (let i = 0; i < n; i += 1) {
    if (random() < winRate) {
      streak += 1;
      const times = PAYOUTS.streakMultipliers.find((s) => streak >= s.from)?.times ?? 1;
      total += reward * times;
    } else {
      streak = 0;
    }
  }
  return total / n;
}

function savingsTable(model: GuideModel): string {
  const target = model.mons.filter((m) => m.pick === null).sort((a, b) => a.price - b.price)[0];
  const rates = [0.5, 0.6, 0.7];
  const tiers = ['great', 'ultra', 'master'];
  const perRound = PAYOUTS.paidMatchesPerRound;
  const rows = tiers
    .map((tier) => {
      const cells = rates
        .map((r) => {
          const perMatch = earningsPerMatch(tier, r);
          const round = perMatch * perRound;
          const rounds = round > 0 ? Math.ceil(target.price / round) : Infinity;
          return `<td class="r">${moneyShort(round)}<br><span class="muted">${Number.isFinite(rounds) ? `${rounds} rounds` : '—'}</span></td>`;
        })
        .join('');
      return `<tr><th>${tier[0].toUpperCase() + tier.slice(1)} Ball <span class="muted">(${moneyShort(PAYOUTS.winReward[tier])}/win)</span></th>${cells}</tr>`;
    })
    .join('');
  return `
  <table class="data">
    <thead><tr><th>Ladder tier</th>${rates.map((r) => `<th class="r">Win ${pct(r)}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">Money per round (${perRound} paid matches), streak multipliers included, and how many rounds of it buy
  ${escape(target.name)} (${money(target.price)}) from nothing. Losses pay nothing.</p>`;
}

// --- private: the simulated draft ------------------------------------------------------------

interface Sims {
  byTeams: Map<number, SimResult>;
}

function runSims(model: GuideModel): Sims {
  const mons = model.mons.map((m) => ({ slug: m.slug, power: m.power, price: m.price }));
  const byTeams = new Map<number, SimResult>();
  for (const teams of [4, 6, 8]) {
    byTeams.set(
      teams,
      simulateDraft({
        mons,
        teams,
        rounds: LEAGUE_DEFAULTS.draftRounds,
        budget: model.budget,
        runs: 400,
        noise: 0.8,
        reservePerPick: 8_000,
        seed: 1000 + teams,
      }),
    );
  }
  return { byTeams };
}

const LEAGUE_SIZES = [4, 6, 8] as const;

/** "72% · ~#9": how often anyone drafts it, and how early when they do. */
function forecastCell(result: SimResult, slug: string): string {
  const share = takenShare(result, slug);
  const pick = medianWhenTaken(result, slug);
  if (share < 0.05 || pick === null) return '<span class="slip">left</span>';
  return `${pct(share)} <span class="muted">· ~#${pick}</span>`;
}

function seatTable(): string {
  const rounds = LEAGUE_DEFAULTS.draftRounds;
  const picksFor = (teams: number, seat: number) =>
    Array.from({ length: rounds }, (_, r) => (r % 2 === 0 ? r * teams + seat : r * teams + (teams - seat + 1))).join(' · ');
  const rows = LEAGUE_SIZES.map(
    (teams) =>
      `<tr><th>${teams} clubs</th><td>${picksFor(teams, 1)}</td><td>${picksFor(teams, Math.ceil(teams / 2))}</td><td>${picksFor(teams, teams)}</td></tr>`,
  ).join('');
  return `<table class="data compact"><thead><tr><th>Draft</th><th>First seat</th><th>Middle seat</th><th>Last seat</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function forecastTable(rows: ScoredMon[], sims: Sims): string {
  return `
  <table class="data compact forecast">
    <thead><tr><th>Pokémon</th><th>Tier</th><th class="r">Price</th><th class="r">Pick</th>${LEAGUE_SIZES.map((t) => `<th>${t} clubs</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map(
        (m) => `
      <tr>
        <td>${monCell(m)}</td><td>${chip(m.tier)}</td><td class="r">${moneyShort(m.price)}</td><td class="r strong">${fmt(m.pick!)}</td>
        ${LEAGUE_SIZES.map((t) => `<td class="f">${forecastCell(sims.byTeams.get(t)!, m.slug)}</td>`).join('')}
      </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function scouting(model: GuideModel, sims: Sims): string {
  // Targets: the top of the Pick board plus every hand-scored budget gem.
  const byPick = model.mons.filter(draftable).sort((a, b) => b.pick! - a.pick!);
  const budgetCat = model.categories.find((c) => c.key === 'budget')!;
  const targets = [...new Set([...byPick.slice(0, 12), ...budgetCat.cards.slice(0, 8).map((c) => c.mon)])].slice(0, 18);

  const eight = sims.byTeams.get(8)!;
  const aPlus = model.mons.filter((m) => m.tier === 'A+');
  const aPlusTaken = (teams: number) =>
    aPlus.reduce((sum, m) => sum + takenShare(sims.byTeams.get(teams)!, m.slug), 0);

  // What slips: good non-star picks still on the board when round 4 opens in an 8-club room.
  const round4 = 3 * 8 + 1;
  const aTier = model.mons.filter((m) => m.tier === 'A');
  const aTierLeft = aTier.reduce((sum, m) => sum + availableAt(eight, m.slug, round4), 0) / aTier.length;
  const slips = byPick
    .filter((m) => m.price <= 150_000)
    .map((m) => ({ m, left: availableAt(eight, m.slug, round4) }))
    .filter((s) => s.left >= 0.5)
    .slice(0, 12);

  // What the room overpays for: strong, famous and dear for what they do.
  const overpay = model.mons
    .filter((m) => draftable(m) && m.power >= 8 && m.value <= 4.8)
    .sort((a, b) => a.value - b.value)
    .slice(0, 5);

  const notesPath = join(ROOT, 'private/scouting-notes.html');
  const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '<p class="muted">Add your own notes in <code>private/scouting-notes.html</code>; they appear here.</p>';

  return `
  <section class="page-break">
    <p class="eyebrow">Private · scouting</p>
    <h2>How the room will draft</h2>
    <p>The forecast comes from ${eight.runs} simulated drafts for each league size. Every club drafts the way most
    people do: it takes the strongest Pokémon it can afford (by Power, with some disagreement between clubs) and keeps
    ${moneyShort(8_000)} back for each pick it still has to make. Nobody in the simulation drafts on Value, and that is
    the point. It shows what a Power-first room takes, and what it leaves.</p>
    <p><strong>The big finding: A+ Pokémon are not scarce, but your particular A+ is a coin flip.</strong> Only one fits a
    budget, so the simulated rooms draft about ${aPlusTaken(4).toFixed(0)}, ${aPlusTaken(6).toFixed(0)} and
    ${aPlusTaken(8).toFixed(0)} of the ${aPlus.length} A+ Pokémon in 4-, 6- and 8-club leagues. The rest go undrafted.
    Go in with three acceptable stars, not one.</p>
    <p><strong>How to read it:</strong> each cell is how often the Pokémon was drafted, and the overall pick it usually
    went at. Compare that pick with your seat's picks below. <span class="slip">left</span> means the room almost never
    took it.</p>
    ${seatTable()}
    ${forecastTable(targets, sims)}
  </section>

  <section class="page-break">
    <p class="eyebrow">Private · scouting</p>
    <h2>What slips, and what gets overpaid</h2>
    <h3>Still there when round 4 opens (8 clubs)</h3>
    <p>Good picks under ${moneyShort(150_000)} that a Power-first room usually leaves for the last three rounds.
    Don't spend an early pick on something the room will leave for you; spend it on what it won't.</p>
    <p><strong>Look at the A tier.</strong> On average ${pct(aTierLeft)} of it is still on the board when round 4 opens.
    A club that opened with an A+ has about ${moneyShort(100_000)} left for five picks, so an A-tier at
    ${moneyShort(TIER_PRICE_BANDS.A[0])}–${moneyShort(TIER_PRICE_BANDS.A[1])} is out of its reach for the rest of the draft.
    If you skip the A+ tier, the whole A tier is yours to pick from, uncontested, in any round.</p>
    ${boardTable(model, slips.map((s) => s.m), (m) => `${pct(slips.find((x) => x.m.slug === m.slug)!.left)} still there`, 'Round 4')}
    <h3>Where rivals overpay</h3>
    <p>Strong, famous and priced near the top of the A+ band: Power 8 or more, but Value 4.8 or less. If a rival spends
    their first pick on one of these, they have ${moneyShort(model.budget - 230_000)} or less for five more picks. Let them.</p>
    ${boardTable(model, overpay)}
  </section>

  <section class="page-break">
    <p class="eyebrow">Private · after the draft</p>
    <h2>The road to an S-tier</h2>
    <p>Once you've bought a Pokémon, it is worth only ${VALUE_RULES.buyKeepPct}% of what you paid. Selling a regretted
    pick gets back less than half, so the draft is expensive to undo. Value then moves with results: +${VALUE_RULES.perf.ultra.win}%
    per win in Ultra Ball, ${VALUE_RULES.perf.ultra.loss}% per loss. The only new money is wins, and it only becomes real money in Ultra Ball and above:</p>
    ${savingsTable(model)}
    <p>Two conclusions. First, <strong>an S-tier is a second-half-of-the-season purchase</strong> for anyone not
    winning most of their Ultra Ball matches: plan the draft squad to carry you. Second, <strong>streaks are where the
    money is</strong> — from the ${PAYOUTS.streakMultipliers.at(-1)!.from}rd straight win payouts triple, from the
    ${PAYOUTS.streakMultipliers[0].from}th they are ×${PAYOUTS.streakMultipliers[0].times}. So play your most reliable
    six, not your flashiest.</p>
    <h2 style="margin-top:28px">My notes</h2>
    <div class="notes">${notes}</div>
  </section>`;
}

// --- the document ---------------------------------------------------------------------------

function build(model: GuideModel, sims: Sims | null): string {
  const generated = new Date().toISOString().slice(0, 10);
  const { budget, tierFile } = model;
  const cheapestS = model.mons.filter((m) => m.pick === null).sort((a, b) => a.price - b.price)[0];
  const [aPlusLow, aPlusHigh] = TIER_PRICE_BANDS['A+'];
  const topPicks = model.mons.filter(draftable).sort((a, b) => b.pick! - a.pick! || b.power - a.power).slice(0, 18);
  const roleCats = model.categories.filter((c) => !['budget', 'save-up'].includes(c.key));
  const budgetCat = model.categories.find((c) => c.key === 'budget')!;
  const saveCat = model.categories.find((c) => c.key === 'save-up')!;
  // One call-out per tier — the best Pick in it — so labels never crowd each other.
  const callouts = (['A+', 'A', 'B', 'C'] as Tier[])
    .map((tier) => model.mons.filter((m) => m.tier === tier && draftable(m)).sort((a, b) => b.pick! - a.pick!)[0]?.slug)
    .filter((s): s is string => Boolean(s));
  const cheapAPlus = model.mons.filter((m) => m.tier === 'A+').sort((a, b) => a.price - b.price).slice(0, 5);
  const dearAPlus = model.mons.filter((m) => m.tier === 'A+').sort((a, b) => b.price - a.price).slice(0, 3);
  const adjusted = model.mons.filter((m) => m.adjustment).sort((a, b) => b.adjustment!.adjust - a.adjustment!.adjust);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Champions Draft Report${PRIVATE ? ' (private)' : ''}</title>
${FONT_LINKS}
<style>
  /* Paper first: this document's whole life is a PDF, so it is designed in ink, on A4. */
  :root {
    --ink: #16181d;
    --muted: #5d6475;
    --line: #d9dce3;
    --panel: #f5f6f8;
    --accent: #b8860b;
    --display: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif;
    --body: 'Barlow', system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  @page { size: A4; margin: 16mm 15mm 18mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: var(--ink); font-family: var(--body); font-size: 10.5pt; line-height: 1.5; background: #fff; }
  h1, h2, h3 { font-family: var(--display); line-height: 1.05; margin: 0; }
  h1 { font-size: 46pt; font-weight: 700; }
  h2 { font-size: 24pt; font-weight: 700; margin: 0 0 8px; }
  h3 { font-size: 14pt; font-weight: 700; margin: 16px 0 6px; }
  p { margin: 0 0 8px; }
  .eyebrow, .kicker { font-family: var(--display); text-transform: uppercase; letter-spacing: 0.14em; font-size: 9pt; color: var(--accent); margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .note { color: var(--muted); font-size: 9pt; }
  .r { text-align: right; }
  .strong { font-weight: 700; }
  code { font-size: 9pt; }
  .page-break { break-before: page; }

  /* cover */
  .cover { border-bottom: 3px solid var(--accent); padding-bottom: 14px; margin-bottom: 18px; }
  .cover .sub { color: var(--muted); font-size: 11pt; margin-top: 6px; }
  .takeaways { counter-reset: t; list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .takeaways li { counter-increment: t; display: grid; grid-template-columns: 34px 1fr; gap: 10px; align-items: start;
    background: var(--panel); border-left: 3px solid var(--accent); padding: 10px 12px; break-inside: avoid; }
  .takeaways li::before { content: counter(t); font-family: var(--display); font-size: 22pt; font-weight: 700; line-height: 1; color: var(--accent); }
  .takeaways strong { display: block; font-size: 11.5pt; }
  .callout { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin-top: 16px; font-size: 9.5pt; color: var(--muted); }
  .callout strong { color: var(--ink); }

  /* tables */
  table.data { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6px 0 10px; }
  table.data th, table.data td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
  table.data td.r, table.data th.r { text-align: right; }
  table.data thead th { font-family: var(--display); text-transform: uppercase; letter-spacing: 0.08em; font-size: 8pt; color: var(--muted); font-weight: 600; }
  table.data tr { break-inside: avoid; }
  table.compact td, table.compact th { padding: 3px 6px 3px 0; font-size: 9pt; }
  .mon { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; }
  .mon img { image-rendering: pixelated; margin: -6px 0; width: 24px; height: 24px; }
  .chip { display: inline-block; font-family: var(--display); font-weight: 700; font-size: 8.5pt; padding: 0 5px; border-radius: 3px; background: var(--tier); color: #111; border: 1px solid #0002; }
  .price { color: var(--muted); font-variant-numeric: tabular-nums; }
  .mega { font-size: 7.5pt; font-weight: 700; background: var(--accent); color: #fff; border-radius: 3px; padding: 0 4px; }
  .gone { display: inline-block; min-width: 72px; font-variant-numeric: tabular-nums; font-size: 8.5pt; }
  .slip { color: var(--accent); font-weight: 600; }

  /* rules grid */
  .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0 12px; }
  .facts div { background: var(--panel); border-radius: 4px; padding: 8px 10px; }
  .facts dt { font-family: var(--display); text-transform: uppercase; letter-spacing: 0.08em; font-size: 8pt; color: var(--muted); }
  .facts dd { margin: 2px 0 0; font-weight: 600; }
  .two-col { display: grid; grid-template-columns: 1.55fr 1fr; gap: 18px; align-items: start; }

  /* chart */
  .chart { margin: 8px 0 12px; }
  .chart svg { width: 100%; height: auto; display: block; font-family: var(--body); }
  .chart .band { fill: #f1f2f5; }
  .chart .band-label { font-family: var(--display); font-size: 12px; font-weight: 700; fill: var(--ink); text-anchor: middle; }
  .chart .grid { stroke: #e3e5ea; stroke-width: 1; }
  .chart .tick, .chart .axis { font-size: 10px; fill: var(--muted); }
  .chart .budget { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 0; opacity: 0.55; }
  .chart .budget-label { font-size: 10px; fill: var(--ink); font-weight: 600; }
  .chart .dot { fill: #8a8f9c; stroke: #fff; stroke-width: 1.5; }
  .chart .hot { fill: var(--accent); stroke: #fff; stroke-width: 2; }
  .chart .hot-label { font-size: 10px; font-weight: 600; fill: var(--ink); paint-order: stroke; stroke: #fff; stroke-width: 3px; }
  .chart figcaption { font-size: 9pt; color: var(--muted); margin-top: 4px; }
  .key { display: inline-flex; align-items: center; gap: 5px; margin-right: 12px; color: var(--ink); font-weight: 600; }
  .k-dot, .k-hot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .k-dot { background: #8a8f9c; }
  .k-hot { background: var(--accent); }

  /* roles */
  .roles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .role { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; break-inside: avoid; }
  .role h3 { margin: 0 0 4px; }
  .role p { font-size: 9.5pt; }
  .role-picks { margin: 6px 0 0; display: grid; gap: 3px; }
  .role-picks div { display: grid; grid-template-columns: 112px 1fr; gap: 6px; font-size: 9pt; align-items: center; }
  .role-picks dt { color: var(--muted); }
  .role-picks dd { margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .none { color: var(--muted); }

  /* score legend */
  .scores { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .scores div { background: var(--panel); border-top: 3px solid var(--c); border-radius: 4px; padding: 8px 10px; break-inside: avoid; }
  .scores dt { font-family: var(--display); font-weight: 700; font-size: 12pt; }
  .scores dd { margin: 2px 0 0; font-size: 9.5pt; }

  /* squads */
  .squads { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .squad { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; break-inside: avoid; }
  .squad h3 { margin: 0 0 4px; }
  .squad h3 .muted { font-family: var(--body); font-size: 9pt; font-weight: 400; }
  .squad p { font-size: 9.5pt; }
  .squad ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; font-size: 9.5pt; }
  .squad li { display: flex; align-items: center; gap: 6px; }

  .checklist { padding-left: 18px; }
  .checklist li { margin-bottom: 6px; }
  .notes { font-size: 10pt; }
  h2, h3 { break-after: avoid; }
  .forecast td.f { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
</head>
<body>

<header class="cover">
  <p class="eyebrow">Pokémon Champions · Fantasy League · ${PRIVATE ? 'Private scouting edition' : 'League edition'}</p>
  <h1>Draft Report</h1>
  <p class="sub">What to draft with ${money(budget)}, and why. Ladder: op.gg doubles, captured ${escape(tierFile.updated)} · Generated ${generated}</p>
</header>

<h2>Five things to know</h2>
<ol class="takeaways">
  <li><div><strong>Nobody can draft an S-tier.</strong>The cheapest, ${escape(cheapestS.name)}, costs ${money(cheapestS.price)}, and the opening budget is ${money(budget)}. The draft is fought over the ${model.mons.filter((m) => m.tier === 'A+').length} A+ Pokémon (${moneyShort(aPlusLow)}–${moneyShort(aPlusHigh)}) and the bargains below them.</div></li>
  <li><div><strong>You have ${moneyShort(budget / LEAGUE_DEFAULTS.lineupSize)} per Pokémon, on average.</strong>One A+ star leaves roughly ${moneyShort(budget - 200_000)}–${moneyShort(budget - aPlusLow)} for the other five. That works, but only if you know which cheap Pokémon do a real job. Most of this report is about those.</div></li>
  <li><div><strong>Prices follow the ladder only between tiers.</strong>Within a tier, price follows base stats, so support Pokémon — whose value is moves, not stats — come cheap. Every tier boundary is a price cliff: one place down the ladder can halve the price.</div></li>
  <li><div><strong>Draft a plan, not a list.</strong>Pick your speed control first (Tailwind, Trick Room or weather), then protect it: Fake Out, Intimidate, redirection. A team of six strong Pokémon with no plan loses to a cheaper team with one.</div></li>
  <li><div><strong>One Mega per battle.</strong>Owning a species gives you its Mega, and its price already includes the Mega. Two Mega Pokémon on one squad means you paid for a Mega you can't use in a given battle.</div></li>
</ol>
<div class="callout"><strong>What is data and what is opinion.</strong> Prices, ladder ranks, who learns which move, and the Value and Pick
scores are data or arithmetic. Power starts from the op.gg rank; it's adjusted in only ${adjusted.length} places, each with a reason
(see the last page). The Role scores and notes are judgement, and my knowledge of the newest Megas (Mega Raichu X and Y, Garchomp Z, Staraptor and others) is thinner than of the classics.
If the ladder and your own experience disagree with this report, trust them.</div>

<section class="page-break">
  <p class="eyebrow">Part 1</p>
  <h2>How the draft works here</h2>
  <dl class="facts">
    <div><dt>Format</dt><dd>Snake draft, ${LEAGUE_DEFAULTS.draftRounds} rounds</dd></div>
    <div><dt>Budget</dt><dd>${money(budget)}, you pay shop price</dd></div>
    <div><dt>Squad</dt><dd>${LEAGUE_DEFAULTS.lineupSize} starters, up to ${LEAGUE_DEFAULTS.squadMax} total</dd></div>
    <div><dt>In a match</dt><dd>Bring ${LEAGUE_DEFAULTS.bringToMatch} of your ${LEAGUE_DEFAULTS.lineupSize}</dd></div>
    <div><dt>Out of money?</dt><dd>You skip your remaining picks</dd></div>
    <div><dt>Resale value</dt><dd>${VALUE_RULES.buyKeepPct}% of what you paid</dd></div>
  </dl>
  <p>Snake order means the club that picks last in round one picks first in round two. A late seat gets two picks close together
  at every turn, which is a good time to take a pair that works together (a setter and its partner).</p>
  <p><strong>Points.</strong> Each Pokémon you bring scores ${SCORING.koLanded} per knockout, ${SCORING.survived} for surviving
  and ${SCORING.fainted} for fainting. A win adds ${SCORING.matchWin}, a win without losing a Pokémon adds ${SCORING.cleanSweep} more, and in a
  head-to-head match between two clubs, beating a club whose squad is worth more adds ${SCORING.upset}. That rewards spread attackers, which
  collect knockouts, and bulky supports, which survive.</p>
  <p><strong>Money</strong> comes only from wins: ${Object.entries(PAYOUTS.winReward)
    .filter(([k]) => k !== 'beginner')
    .map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)} ${moneyShort(v)}`)
    .join(', ')} per win, tripled from a 3-win streak and ×5 from a 5-win streak, for up to ${PAYOUTS.paidMatchesPerRound} paid matches a round.
  At Poké Ball and Great Ball that's pocket money, so <strong>the squad you draft is the squad you play for weeks.</strong></p>
  <h3 style="margin-top:20px">On draft night, in five steps</h3>
  <ol class="checklist">
    <li><strong>Before the draft</strong>, choose a speed plan and a backup: Tailwind, Trick Room, or a weather. Write down two setters for each.</li>
    <li><strong>Round 1:</strong> your star, or your setter. An A+ at ${moneyShort(aPlusLow)}–${moneyShort(200_000)} leaves room for five; one at ${moneyShort(aPlusHigh)} leaves ${moneyShort(budget - aPlusHigh)}.</li>
    <li><strong>Rounds 2–3:</strong> whatever protects the plan — Fake Out, Intimidate, redirection — and your one Mega.</li>
    <li><strong>Rounds 4–6:</strong> budget gems that fill a gap. There are ${model.mons.filter((m) => m.price <= BUDGET_CEILING).length} Pokémon at ${moneyShort(BUDGET_CEILING)} or less; they don't run out, so don't take them early.</li>
    <li><strong>Keep a little cash</strong> for a free agent once the season shows what's missing. Remember it only grows through wins.</li>
  </ol>

</section>

<section class="page-break">
  <p class="eyebrow">Part 2</p>
  <h2>Where the bargains are</h2>
  ${priceChart(model, callouts)}
  <div class="two-col">
    <div>
      <h3>The cliffs</h3>
      <table class="data compact">
        <thead><tr><th>Last of the tier above</th><th>First of the tier below</th><th class="r">Saving</th></tr></thead>
        <tbody>${cliffs(model)
          .map(
            ({ above, below }) => `<tr><td>${escape(above.name)} #${above.rank} ${chip(above.tier)} ${moneyShort(above.price)}</td><td>${escape(below.name)} #${below.rank} ${chip(below.tier)} <strong>${moneyShort(below.price)}</strong></td><td class="r">${pct(1 - below.price / above.price)}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>
    <div>
      <h3>Supports come cheap</h3>
      <p>The cheapest A+ Pokémon are the support specialists, ranked as high as the attackers that cost ${moneyShort(dearAPlus[0].price)}:</p>
      <table class="data compact"><tbody>${cheapAPlus
        .map((m) => `<tr><td>${monCell(m)}</td><td>#${m.rank}</td><td class="r">${moneyShort(m.price)}</td></tr>`)
        .join('')}</tbody></table>
    </div>
  </div>
</section>

<section class="page-break">
  <p class="eyebrow">Part 3</p>
  <h2>The roles, in plain words</h2>
  <p>Doubles is won by moving first, protecting whatever moves you first, and hitting both opponents at once.
  These are the jobs that make that happen, each with the best Pokémon there is, the best one you can
  draft with ${money(budget)}, and the best one under ${moneyShort(BUDGET_CEILING)}.</p>
  <div class="roles">${roleCats.map(roleRow).join('')}</div>
</section>

<section class="page-break">
  <p class="eyebrow">Part 4</p>
  <h2>How to read the scores</h2>
  <dl class="scores">
    <div style="--c:#d6457f"><dt>Role · 1–10</dt><dd>How good it is at one category's job. Hand-scored: a 10 is the Pokémon the job is named after. The same Pokémon has different Role scores in different categories.</dd></div>
    <div style="--c:#c9a000"><dt>Power · 1–10</dt><dd>How good it is overall: its op.gg doubles rank on a 1–10 scale (#1 is 10, #${model.total} is 1), with ${adjusted.length} hand adjustments.</dd></div>
    <div style="--c:#178f85"><dt>Value · 1–10</dt><dd>Power for the price. 5 is what that Power usually costs; 7 is about half price. Computed, so it moves with every reprice.</dd></div>
    <div style="--c:var(--accent)"><dt>Pick · 1–10</dt><dd>Draft priority: 60% Power plus 40% Value. Power leads, because a bargain that loses matches is still a loss. S-tiers get no Pick: you can't draft them.</dd></div>
  </dl>
  <h3>Top ${topPicks.length} draft picks, by Pick</h3>
  ${boardTable(model, topPicks)}
</section>

<section class="page-break">
  <p class="eyebrow">Part 5</p>
  <h2>Sample squads</h2>
  <p>Four complete drafts, each within ${money(budget)} with one planned Mega. The build checks both, so these add up. Someone
  will take one of these picks before you, so read them as shapes: a speed plan, its protection, and damage.</p>
  <div class="squads">${squadsSection(model)}</div>

</section>

${sims ? scouting(model, sims) : ''}

<section class="page-break">
  <p class="eyebrow">Appendix</p>
  <h2>Method</h2>
  <p><strong>Who qualifies</strong> for a role is read from PokéAPI: moves from each Pokémon's Champions learnset, pooled across
  its forms, plus its abilities and its Megas' abilities. ${model.mons.filter((m) => m.kit.learnsetFrom !== 'champions').length} Pokémon have no Champions learnset
  on PokéAPI yet; for those, Scarlet/Violet or Sword/Shield stands in, and the guide says so on their card.</p>
  <p><strong>Value</strong> fits log(price) against Power across all ${model.total} Pokémon, then scores each by how far below (good)
  or above (bad) that line it sits. Because prices are flat inside a tier while Power keeps falling, the top of each tier
  scores well: that's the cliff effect, and it's real.</p>
  <h3>Where Power overrules the ladder</h3>
  <table class="data">
    <thead><tr><th>Pokémon</th><th class="r">Rank</th><th class="r">Power</th><th>Why</th></tr></thead>
    <tbody>${adjusted
      .map((m) => `<tr><td>${monCell(m)}</td><td class="r">#${m.rank}</td><td class="r">${fmt(m.basePower)} → <strong>${fmt(m.power)}</strong></td><td>${escape(m.adjustment!.why)}</td></tr>`)
      .join('')}</tbody>
  </table>
  <h3>Save-up targets</h3>
  <p>${saveCat.cards
    .slice(0, 6)
    .map((c) => `<strong>${escape(c.mon.name)}</strong> (${moneyShort(c.mon.price)})`)
    .join(', ')}. See the guide for the full list.</p>
  <p class="note">Built from data/roster.json, data/tiers.json and data/draft-guide.json. The interactive version is data/draft-guide.html.
  Regenerate with <code>npm run guide:report${PRIVATE ? ' -- --private' : ''}</code>.</p>
</section>

</body>
</html>`;
}

async function main() {
  const model = loadGuide();
  const sims = PRIVATE ? runSims(model) : null;
  const html = build(model, sims);

  const out = PRIVATE ? join(ROOT, 'private/scouting-report.pdf') : join(ROOT, 'reports/draft-report.pdf');
  mkdirSync(dirname(out), { recursive: true });
  // Keep the HTML beside the PDF: it is what to open when a page looks wrong.
  writeFileSync(out.replace(/\.pdf$/, '.html'), html);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: out,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#8a8f9c;padding:0 15mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>Champions Draft Report · ${PRIVATE ? 'private scouting edition' : 'league edition'}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${out.replace(`${ROOT}/`, '')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
