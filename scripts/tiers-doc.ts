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

import { LEAGUE_DEFAULTS, TIERS, type Tier } from '../config/economy.ts';
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
  slug: string;
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
    slug: p.slug,
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
          <li>
            <button type="button" class="mon" aria-pressed="false"
              data-slug="${escape(r.slug)}" data-name="${escape(r.name)}"
              data-price="${r.baseValue}" data-tier="${escape(r.tier)}">
              <span class="mon-name">${escape(r.name)}${r.megas ? `<span class="mega" title="${r.megas} Mega Evolution${r.megas > 1 ? 's' : ''} included">M</span>` : ''}${r.restricted ? '<span class="restricted" title="On the roster but not catchable">·</span>' : ''}</span>
              <span class="mon-meta">${escape(r.types.join(' / '))} · ${r.bst} BST</span>
              <span class="mon-price tabular">${money(r.baseValue)}</span>
              <span class="mon-tick" aria-hidden="true"></span>
            </button>
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

  .mons > li { display: grid; }

  .mon {
    display: grid;
    grid-template-columns: 1fr auto auto;
    grid-template-areas: 'name price tick' 'meta price tick';
    align-items: center;
    column-gap: 10px;
    padding: 8px 10px;
    background: var(--panel);
    border: 0;
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    position: relative;
  }
  .mons > li:nth-child(even) .mon { background: var(--panel-2); }
  .mon:hover { background: #232838; }
  .mon:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; z-index: 1; }

  /* Picked: a left rail in the tier's own colour, plus a tick that only occupies space once
     it has something to show — otherwise every row carries a permanent empty column. */
  .mon-tick { grid-area: tick; width: 0; color: var(--accent); font-weight: 700; }
  .mon[aria-pressed='true'] { background: #1b2030; box-shadow: inset 3px 0 0 var(--tier); }
  .mons > li:nth-child(even) .mon[aria-pressed='true'] { background: #1b2030; }
  .mon[aria-pressed='true'] .mon-tick { width: auto; }
  .mon[aria-pressed='true'] .mon-tick::before { content: '✓'; }
  .mon[aria-pressed='true'] .mon-name { color: var(--accent); }

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

  /* --- the shortlist ------------------------------------------------------------------- */
  /*
   * Pinned rather than in the flow, because the whole point is to keep the running total in
   * view while you scroll six tiers of Pokémon. Wide screens get a rail on the right; narrow
   * ones get a bar along the bottom that opens upward, where a thumb already is.
   */
  .cart {
    position: fixed;
    z-index: 20;
    background: var(--panel-2);
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px #0008;
  }

  .cart-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 12px 14px;
    background: none;
    border: 0;
    color: var(--ink);
    font: inherit;
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 13px;
    cursor: pointer;
  }
  .cart-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cart-toggle .count { color: var(--accent); font-weight: 700; }
  .cart-toggle .total { margin-left: auto; font-size: 15px; font-variant-numeric: tabular-nums; }
  .cart-chev { transition: transform 0.15s ease; }
  .cart[data-open='false'] .cart-chev { transform: rotate(180deg); }

  .cart-body { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--line); }
  .cart[data-open='false'] .cart-body { display: none; }

  .cart-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; flex: 1; }
  .cart-list li + li { border-top: 1px solid var(--line); }

  .cart-item {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: 2px 10px;
    width: 100%;
    padding: 8px 14px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .cart-item:hover { background: #262c3d; }
  .cart-item:hover .cart-x { color: var(--negative); }
  .cart-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cart-item .nm { font-weight: 600; }
  .cart-item .pr { font-variant-numeric: tabular-nums; color: var(--muted); }
  .cart-item .tr { font-size: 11px; color: var(--tier); font-family: var(--display); letter-spacing: 0.08em; }
  .cart-x { color: var(--muted); font-size: 16px; line-height: 1; }

  .cart-empty { margin: 0; padding: 16px 14px; color: var(--muted); font-size: 13px; }

  .cart-sums { margin: 0; padding: 10px 14px; border-top: 1px solid var(--line); display: grid; gap: 4px; }
  .cart-sums > div { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
  .cart-sums dt { color: var(--muted); }
  .cart-sums dd { margin: 0; font-variant-numeric: tabular-nums; }
  .cart-sums .over dd, .cart-sums dd.over { color: var(--negative); font-weight: 600; }
  .cart-note { margin: 0; padding: 0 14px 10px; font-size: 12px; color: var(--negative); }

  .cart-clear {
    margin: 0;
    padding: 9px 14px;
    background: none;
    border: 0;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .cart-clear:hover { color: var(--negative); }
  .cart-clear:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  /* Narrow: a bar on the bottom edge that opens upward. */
  @media (max-width: 999px) {
    .cart {
      left: 0;
      right: 0;
      bottom: 0;
      border-width: 1px 0 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      max-height: 75vh;
    }
    .cart-list { max-height: 45vh; }
  }

  /* Wide: a rail on the right. The page keeps clear of it rather than sliding underneath. */
  @media (min-width: 1000px) {
    .cart {
      top: env(safe-area-inset-top, 0px);
      right: 16px;
      width: 290px;
      max-height: min(80vh, 760px);
      margin-top: 24px;
      border-radius: 8px;
      overflow: hidden;
    }
    .page { padding-right: 330px; max-width: 1420px; }
  }

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
    .page { padding-block: 0; padding-right: 16px; max-width: none; }
    .mons { grid-template-columns: repeat(3, 1fr); }
    .tier { break-inside: avoid; }
    .chip { color: #111; border: 1px solid #0003; }
    a { text-decoration: none; }
    /* The shortlist is a screen tool; on paper a picked Pokémon is just marked. */
    .cart { display: none; }
    .mon { cursor: auto; }
    .mon[aria-pressed='true'] { background: #f4f0dd; box-shadow: inset 3px 0 0 #333; }
    .mon[aria-pressed='true'] .mon-name { color: inherit; }
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
    <p>Tap any Pokémon to put it in your shortlist and watch the outlay against a ₽${LEAGUE_DEFAULTS.startingCash.toLocaleString('en-US')} opening budget. Tap it again — in the list or in the tiers — to take it out. The shortlist is yours alone: it lives in this browser and is not a signing.</p>
    <p><strong>M</strong> marks a Pokémon whose Mega Evolutions come with it — owning the species grants them, and the price reflects that. <strong>·</strong> marks one that is on the roster but not catchable.</p>
    <p>Tier source: ${escape(tierFile.source ?? '—')}.</p>
    <p>Regenerate with <code>npm run tiers:doc</code>. Prices are set by <code>config/economy.ts</code>; the tier of each Pokémon by <code>data/tiers.json</code>.</p>
  </footer>
</main>

<aside class="cart" id="cart" data-open="true" aria-label="Your shortlist">
  <button type="button" class="cart-toggle" id="cartToggle" aria-expanded="true" aria-controls="cartBody">
    <span class="count" id="cartCount">0</span>
    <span>picked</span>
    <span class="total tabular" id="cartTotal">₽0</span>
    <span class="cart-chev" aria-hidden="true">▾</span>
  </button>
  <div class="cart-body" id="cartBody">
    <p class="cart-empty" id="cartEmpty">Tap a Pokémon to start a shortlist.</p>
    <ol class="cart-list" id="cartList"></ol>
    <dl class="cart-sums">
      <div><dt>Squad</dt><dd id="sumCount">0 / ${LEAGUE_DEFAULTS.squadMax}</dd></div>
      <div><dt>Outlay</dt><dd id="sumTotal" class="tabular">₽0</dd></div>
      <div><dt>Left of ₽${LEAGUE_DEFAULTS.startingCash.toLocaleString('en-US')}</dt><dd id="sumLeft" class="tabular">₽${LEAGUE_DEFAULTS.startingCash.toLocaleString('en-US')}</dd></div>
    </dl>
    <p class="cart-note" id="cartNote" hidden></p>
    <button type="button" class="cart-clear" id="cartClear">Clear the shortlist</button>
  </div>
</aside>

<script>
(function () {
  var BUDGET = ${LEAGUE_DEFAULTS.startingCash};
  var SQUAD_MAX = ${LEAGUE_DEFAULTS.squadMax};
  var LINEUP = ${LEAGUE_DEFAULTS.lineupSize};
  var KEY = 'pkf.shortlist.v1';

  var cart = document.getElementById('cart');
  var list = document.getElementById('cartList');
  var empty = document.getElementById('cartEmpty');
  var note = document.getElementById('cartNote');
  var toggle = document.getElementById('cartToggle');
  var body = document.getElementById('cartBody');

  // slug -> {name, price, tier}. A Map keeps insertion order, so the list reads as the order
  // you picked them rather than re-sorting under your finger.
  var picked = new Map();

  var money = function (n) { return '₽' + n.toLocaleString('en-US'); };
  var buttons = function () { return document.querySelectorAll('.mon'); };

  // Storage is a convenience, not a source of truth: a private window or blocked site data
  // throws here, and the page has to work anyway.
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(Array.from(picked.keys()))); } catch (e) {}
  }
  function restore() {
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return; }
    if (!Array.isArray(saved)) return;
    var bySlug = {};
    buttons().forEach(function (b) { bySlug[b.dataset.slug] = b; });
    saved.forEach(function (slug) {
      var b = bySlug[slug];
      // Silently drop anything a repricing has removed from the roster.
      if (b) picked.set(slug, { name: b.dataset.name, price: +b.dataset.price, tier: b.dataset.tier });
    });
  }

  function render() {
    var total = 0;
    picked.forEach(function (p) { total += p.price; });
    var count = picked.size;

    document.getElementById('cartCount').textContent = String(count);
    document.getElementById('cartTotal').textContent = money(total);
    document.getElementById('sumCount').textContent = count + ' / ' + SQUAD_MAX;
    document.getElementById('sumTotal').textContent = money(total);

    var left = BUDGET - total;
    var leftEl = document.getElementById('sumLeft');
    leftEl.textContent = (left < 0 ? '-' : '') + money(Math.abs(left));
    leftEl.classList.toggle('over', left < 0);

    var problems = [];
    if (left < 0) problems.push('Over budget by ' + money(-left) + '.');
    if (count > SQUAD_MAX) problems.push('A squad holds ' + SQUAD_MAX + '.');
    if (count > LINEUP && problems.length === 0) {
      problems.push('Only ' + LINEUP + ' can start; the rest are reserves.');
    }
    note.hidden = problems.length === 0;
    note.textContent = problems.join(' ');
    note.style.color = left < 0 || count > SQUAD_MAX ? '' : 'var(--muted)';

    empty.hidden = count > 0;
    list.textContent = '';
    picked.forEach(function (p, slug) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cart-item';
      b.style.setProperty('--tier', tierColour(p.tier));
      b.setAttribute('aria-label', 'Remove ' + p.name + ' from the shortlist');
      b.innerHTML =
        '<span class="nm"></span><span class="cart-x" aria-hidden="true">×</span>' +
        '<span class="tr"></span><span class="pr"></span>';
      b.querySelector('.nm').textContent = p.name;
      b.querySelector('.tr').textContent = p.tier;
      b.querySelector('.pr').textContent = money(p.price);
      b.addEventListener('click', function () { setPicked(slug, false); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  var COLOURS = ${JSON.stringify(TIER_COLOUR)};
  function tierColour(t) { return COLOURS[t] || '#6b7280'; }

  function setPicked(slug, on) {
    var btn = document.querySelector('.mon[data-slug="' + CSS.escape(slug) + '"]');
    if (on) {
      if (!btn) return;
      picked.set(slug, { name: btn.dataset.name, price: +btn.dataset.price, tier: btn.dataset.tier });
    } else {
      picked.delete(slug);
    }
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    save();
    render();
  }

  buttons().forEach(function (btn) {
    btn.addEventListener('click', function () {
      setPicked(btn.dataset.slug, btn.getAttribute('aria-pressed') !== 'true');
    });
  });

  document.getElementById('cartClear').addEventListener('click', function () {
    picked.clear();
    buttons().forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    save();
    render();
  });

  toggle.addEventListener('click', function () {
    var open = cart.dataset.open !== 'true';
    cart.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  restore();
  picked.forEach(function (_p, slug) {
    var b = document.querySelector('.mon[data-slug="' + CSS.escape(slug) + '"]');
    if (b) b.setAttribute('aria-pressed', 'true');
  });
  // Start collapsed on a phone, where an open sheet would cover the tiers it is about.
  if (window.matchMedia('(max-width: 999px)').matches) {
    cart.dataset.open = 'false';
    toggle.setAttribute('aria-expanded', 'false');
  }
  render();
})();
</script>
`;
}

const html = build();
const out = join(ROOT, 'data/tiers.html');
writeFileSync(out, html);
console.log(`Wrote data/tiers.html (${(html.length / 1024).toFixed(0)} KB). Open it, or print to PDF.`);
