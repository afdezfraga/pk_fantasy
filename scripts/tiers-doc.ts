/**
 * Renders the market as a standalone page: `data/tiers.html`.
 *
 *   npm run tiers:doc
 *
 * Run it after every repricing, so there is always a readable record of what the league's
 * Pokémon cost and why — the roster revision and tier source are stamped on it. Open it in a
 * browser to read, or print to PDF to hand round before a draft; the print stylesheet switches
 * to ink on paper and keeps each tier on one page.
 *
 * Deliberately self-contained apart from the webfont: one file that can be mailed, committed,
 * or opened years later without the app running.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, type Tier } from '../config/economy.ts';
import type { RosterFile } from '../lib/roster/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The app's tier colours, so a Pokémon reads the same here as on the market page. */
const TIER_COLOUR: Record<Tier, string> = {
  S: '#ff5c5c',
  'A+': '#ff9f43',
  A: '#ffd93d',
  B: '#6bcb77',
  C: '#4d96ff',
  D: '#9b8fd6',
  UR: '#6b7280',
};

const money = (n: number) => `₽${n.toLocaleString('en-US')}`;
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Row {
  name: string;
  tier: Tier;
  baseValue: number;
  bst: number;
  types: string[];
  megas: number;
  restricted: boolean;
}

function build(): string {
  const roster: RosterFile = JSON.parse(readFileSync(join(ROOT, 'data/roster.json'), 'utf8'));
  const tierFile = JSON.parse(readFileSync(join(ROOT, 'data/tiers.json'), 'utf8'));

  const rows: Row[] = roster.pokemon.map((p: any) => ({
    name: p.form ? `${p.form.replace(/\bForms?\b/gi, '').replace(/\s+/g, ' ').trim()} ${p.name}`.trim() : p.name,
    tier: p.tier,
    baseValue: p.baseValue,
    bst: p.effectiveBst ?? p.bst,
    types: p.types ?? [],
    megas: (p.megas ?? []).length,
    restricted: Boolean(p.restricted),
  }));

  const total = rows.length;
  const used = TIERS.filter((t) => rows.some((r) => r.tier === t));
  const generated = new Date().toISOString().slice(0, 10);

  const summary = used.map((tier) => {
    const inTier = rows.filter((r) => r.tier === tier);
    const prices = inTier.map((r) => r.baseValue);
    return {
      tier,
      count: inTier.length,
      share: (inTier.length / total) * 100,
      low: Math.min(...prices),
      high: Math.max(...prices),
    };
  });

  const sections = used
    .map((tier) => {
      const inTier = rows.filter((r) => r.tier === tier).sort((a, b) => b.baseValue - a.baseValue);
      const band = summary.find((s) => s.tier === tier)!;
      const cards = inTier
        .map(
          (r) => `
          <li class="mon">
            <span class="mon-name">${escape(r.name)}${r.megas ? `<span class="mega" title="${r.megas} Mega Evolution${r.megas > 1 ? 's' : ''} included">M</span>` : ''}${r.restricted ? '<span class="restricted" title="On the roster but not catchable">·</span>' : ''}</span>
            <span class="mon-meta">${escape(r.types.join(' / '))} · ${r.bst} BST</span>
            <span class="mon-price tabular">${money(r.baseValue)}</span>
          </li>`,
        )
        .join('');

      return `
      <section class="tier" style="--tier:${TIER_COLOUR[tier]}">
        <header class="tier-head">
          <h2>${tier}</h2>
          <p class="tier-band tabular">${money(band.low)} – ${money(band.high)}</p>
          <p class="tier-count tabular">${band.count} <span>· ${band.share.toFixed(1)}% of the roster</span></p>
        </header>
        <ul class="mons">${cards}</ul>
      </section>`;
    })
    .join('');

  const summaryRows = summary
    .map(
      (s) => `
      <tr style="--tier:${TIER_COLOUR[s.tier]}">
        <th scope="row"><span class="chip">${s.tier}</span></th>
        <td class="tabular">${s.count}</td>
        <td class="share"><span class="bar" style="--w:${s.share.toFixed(1)}%"></span><span class="tabular">${s.share.toFixed(1)}%</span></td>
        <td class="tabular price">${money(s.low)} – ${money(s.high)}</td>
      </tr>`,
    )
    .join('');

  return `<title>Champions Market</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap">
<style>
  /*
   * Dark like the app it belongs to — this gets read on a phone, mid-draft. Print flips to
   * ink on paper, because the other half of this document's life is a PDF before a draft.
   */
  :root {
    --surface: #0f1117;
    --panel: #171a23;
    --panel-2: #1e222e;
    --line: #2a2f3d;
    --ink: #e8eaf0;
    --muted: #949cb0;
    --accent: #ffcb05;
    --display: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif;
    --body: 'Barlow', system-ui, -apple-system, 'Segoe UI', sans-serif;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--surface);
    color: var(--ink);
    font-family: var(--body);
    font-size: 15px;
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
  }

  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding-inline: 16px;
    padding-block: 40px 64px;
  }

  .tabular { font-variant-numeric: tabular-nums; }

  /* --- masthead ------------------------------------------------------------------------ */
  .masthead { border-bottom: 2px solid var(--accent); padding-bottom: 20px; }

  .eyebrow {
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 13px;
    color: var(--accent);
    margin: 0 0 4px;
  }

  h1 {
    font-family: var(--display);
    font-size: clamp(38px, 8vw, 62px);
    font-weight: 700;
    line-height: 0.95;
    letter-spacing: -0.01em;
    margin: 0;
    text-wrap: balance;
  }

  .lede { color: var(--muted); margin: 12px 0 0; max-width: 62ch; }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px 24px;
    margin-top: 24px;
    padding: 0;
    list-style: none;
  }
  .facts div { display: flex; flex-direction: column; gap: 2px; }
  .facts dt {
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
    color: var(--muted);
  }
  .facts dd { margin: 0; font-size: 14px; }
  .facts a { color: var(--ink); text-decoration-color: var(--line); }
  .facts a:hover { text-decoration-color: var(--accent); }

  /* --- the bands table ----------------------------------------------------------------- */
  h2.section {
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 14px;
    color: var(--muted);
    margin: 48px 0 12px;
  }

  .bands-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 480px; }
  th, td { text-align: left; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--line); }
  thead th {
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
  }
  tbody th { width: 52px; }

  .chip {
    display: inline-block;
    min-width: 32px;
    text-align: center;
    font-family: var(--display);
    font-weight: 700;
    font-size: 14px;
    padding: 2px 8px;
    border-radius: 4px;
    color: #12141b;
    background: var(--tier);
  }

  .share { width: 34%; }
  .bar {
    display: inline-block;
    height: 7px;
    width: var(--w);
    background: var(--tier);
    border-radius: 3px;
    margin-right: 10px;
    vertical-align: middle;
    min-width: 3px;
  }
  td.price { color: var(--muted); white-space: nowrap; }

  /* --- tier sections ------------------------------------------------------------------- */
  .tier { margin-top: 40px; break-inside: avoid; }

  .tier-head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-wrap: wrap;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--tier);
  }
  .tier-head h2 {
    font-family: var(--display);
    font-size: 34px;
    font-weight: 700;
    margin: 0;
    color: var(--tier);
    line-height: 1;
  }
  .tier-band { margin: 0; font-size: 14px; color: var(--ink); }
  .tier-count { margin: 0 0 0 auto; font-size: 13px; color: var(--muted); }
  .tier-count span { color: var(--muted); }

  /*
   * Hairlines come from the cells themselves, not a background showing through a 1px gap:
   * a tier whose last row is short would otherwise end in a block of filled empty cells.
   */
  .mons {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  }

  .mon {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: 'name price' 'meta price';
    align-items: center;
    column-gap: 10px;
    padding: 8px 10px;
    background: var(--panel);
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .mon:nth-child(even) { background: var(--panel-2); }

  .mon-name { grid-area: name; font-weight: 600; }
  .mon-meta { grid-area: meta; font-size: 12px; color: var(--muted); }
  .mon-price { grid-area: price; font-weight: 600; white-space: nowrap; }

  .mega {
    display: inline-block;
    margin-left: 5px;
    font-size: 10px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--tier);
    color: #12141b;
    vertical-align: 1px;
  }
  .restricted { color: var(--muted); margin-left: 4px; }

  footer {
    margin-top: 56px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 13px;
  }
  footer p { margin: 0 0 6px; }

  /* --- print: the other half of this document's life ----------------------------------- */
  @media print {
    :root { --surface: #fff; --panel: #fff; --panel-2: #fafafa; --line: #d8d8d8; --ink: #111; --muted: #555; --accent: #b38f00; }
    body { font-size: 10.5pt; }
    .page { padding-block: 0; max-width: none; }
    .mons { grid-template-columns: repeat(3, 1fr); }
    .tier { break-inside: avoid; }
    .chip { color: #111; border: 1px solid #0003; }
    a { text-decoration: none; }
    @page { margin: 14mm; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>

<main class="page">
  <header class="masthead">
    <p class="eyebrow">Pokémon Champions · Fantasy League</p>
    <h1>Champions Market</h1>
    <p class="lede">
      What every Pokémon costs to sign, by competitive tier. Prices come from the doubles
      ladder, not raw stats — base stats only spread Pokémon out within a tier. Against a
      ₽300,000 opening budget, one S-tier costs more than a whole starting balance.
    </p>
    <dl class="facts">
      <div><dt>Tier source</dt><dd><a href="${escape(tierFile.sourceUrl ?? '#')}">${escape(tierFile.sourceUrl ? 'op.gg doubles ladder' : 'see data/tiers.json')}</a></dd></div>
      <div><dt>Tiers captured</dt><dd>${escape(tierFile.updated ?? '—')}</dd></div>
      <div><dt>Format</dt><dd>${escape((tierFile.format ?? 'doubles').replace(/^./, (c: string) => c.toUpperCase()))}</dd></div>
      <div><dt>Roster revision</dt><dd>Bulbapedia r${escape(String(roster.source?.revisionId ?? '—'))}</dd></div>
      <div><dt>Assets</dt><dd>${total} tradable</dd></div>
      <div><dt>Sheet generated</dt><dd>${generated}</dd></div>
    </dl>
  </header>

  <h2 class="section">The bands</h2>
  <div class="bands-wrap">
    <table>
      <thead>
        <tr><th scope="col">Tier</th><th scope="col">Count</th><th scope="col">Share of roster</th><th scope="col">Price range</th></tr>
      </thead>
      <tbody>${summaryRows}</tbody>
    </table>
  </div>

  <h2 class="section">Every Pokémon, by tier</h2>
  ${sections}

  <footer>
    <p><strong>M</strong> marks a Pokémon whose Mega Evolutions come with it — owning the species grants them, and the price reflects that. <strong>·</strong> marks one that is on the roster but not catchable.</p>
    <p>Tier source: ${escape(tierFile.source ?? '—')}.</p>
    <p>Regenerate with <code>npm run tiers:doc</code>. Prices are set by <code>config/economy.ts</code>; the tier of each Pokémon by <code>data/tiers.json</code>.</p>
  </footer>
</main>
`;
}

const html = build();
const out = join(ROOT, 'data/tiers.html');
writeFileSync(out, html);
console.log(`Wrote data/tiers.html (${(html.length / 1024).toFixed(0)} KB). Open it, or print to PDF.`);
