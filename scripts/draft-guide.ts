/**
 * Renders the draft guide: `data/draft-guide.html`.
 *
 *   npm run guide:doc
 *
 * The companion to `tiers.html`. The market sheet says what everything costs; this says what
 * everything is *for* — the doubles roles that matter, the best Pokémon in each, and scores
 * for how good, how good at the job, and how good for the money.
 *
 * Run it after every repricing (`market:update` does). Value and Pick are computed from the
 * shop price, so a stale guide would recommend bargains that no longer exist.
 *
 * Self-contained apart from the webfont and the sprites, like the market sheet.
 *
 * Committed next to its source, `data/draft-guide.json`, like the market sheet: a reprice or a
 * changed score shows up as a reviewable diff in what the league will actually read.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEAGUE_DEFAULTS } from '../config/economy.ts';
import { FONT_LINKS, TIER_COLOUR, TOKENS_CSS, escape, money, moneyShort } from './doc-kit.ts';
import { ROOT, loadGuide, type CardEntry, type Category, type GuideModel, type ScoredMon } from './guide-model.ts';

const LEARNSET_LABEL: Record<string, string> = {
  'scarlet-violet': 'Scarlet/Violet',
  'sword-shield': 'Sword/Shield',
  any: 'an older game',
};

const fmt = (n: number) => n.toFixed(1);

function sprite(mon: ScoredMon, size: number): string {
  if (!mon.iconUrl) return `<span class="sprite sprite-empty" style="width:${size}px;height:${size}px"></span>`;
  return `<img class="sprite" src="${escape(mon.iconUrl)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
}

function chip(mon: ScoredMon): string {
  return `<span class="chip" style="--tier:${TIER_COLOUR[mon.tier]}">${escape(mon.tier)}</span>`;
}

function bar(label: string, value: number, kind: string, title: string): string {
  return `
      <div class="bar-row" title="${escape(title)}">
        <dt>${label}</dt>
        <dd><span class="track"><span class="fill ${kind}" style="--v:${value}"></span></span><b class="tabular">${fmt(value)}</b></dd>
      </div>`;
}

function pickBadge(mon: ScoredMon): string {
  if (mon.pick === null) {
    return `<div class="pick save" title="Costs more than the ₽${LEAGUE_DEFAULTS.startingCash.toLocaleString('en-US')} opening budget: a target for later, not a draft pick"><span class="pick-num">Save</span><span class="pick-lbl">up</span></div>`;
  }
  return `<div class="pick" title="Draft priority: 60% Power, 40% Value"><span class="pick-num tabular">${fmt(mon.pick)}</span><span class="pick-lbl">Pick</span></div>`;
}

function powerTitle(mon: ScoredMon): string {
  const base = `Power ${fmt(mon.power)}: op.gg doubles rank #${mon.rank}`;
  if (!mon.adjustment) return base;
  const sign = mon.adjustment.adjust > 0 ? '+' : '';
  return `${base} gives ${fmt(mon.basePower)}, adjusted ${sign}${mon.adjustment.adjust} — ${mon.adjustment.why}`;
}

function card(entry: CardEntry, index: number): string {
  const { mon } = entry;
  const inferred =
    mon.kit.learnsetFrom !== 'champions'
      ? `<span class="inferred" title="PokéAPI has no Champions learnset for this Pokémon yet; moves are read from ${LEARNSET_LABEL[mon.kit.learnsetFrom]}">learnset: ${LEARNSET_LABEL[mon.kit.learnsetFrom]}</span>`
      : '';
  const tags = mon.tags.length
    ? `<ul class="tags">${mon.tags.map((t) => `<li>${escape(t)}</li>`).join('')}</ul>`
    : '';

  return `
    <article class="card" data-price="${mon.price}" style="--tier:${TIER_COLOUR[mon.tier]}">
      <span class="ordinal tabular" aria-hidden="true">${index + 1}</span>
      <header class="card-head">
        ${sprite(mon, 56)}
        <div class="card-id">
          <h4 class="card-name">${escape(mon.name)} ${chip(mon)}</h4>
          <p class="card-meta tabular"><strong>${moneyShort(mon.price)}</strong> · #${mon.rank} doubles · ${escape(mon.types.join('/'))}</p>
        </div>
        ${pickBadge(mon)}
      </header>
      <p class="card-via">${escape(entry.reasons.join(' · '))} ${inferred}</p>
      <dl class="bars">
        ${bar('Role', entry.role, 'role', 'How good it is at this category’s job (hand-scored)')}
        ${bar(mon.adjustment ? 'Power*' : 'Power', mon.power, 'power', powerTitle(mon))}
        ${bar('Value', mon.value, 'value', 'Power for the price: 5 is the going rate, higher is a bargain')}
      </dl>
      <p class="card-note">${escape(entry.note)}</p>
      ${tags}
    </article>`;
}

/** Everyone else who qualifies. Capped, because 140 spread attackers is a list, not advice. */
const CHIP_CAP = 36;

function others(category: Category): string {
  if (category.others.length === 0) return '';
  const chipFor = ({ mon, reasons }: Category['others'][number]) => `
      <li class="also" data-price="${mon.price}" style="--tier:${TIER_COLOUR[mon.tier]}" title="${escape(`${reasons.join(' · ')} — Power ${fmt(mon.power)}, Value ${fmt(mon.value)}${mon.pick === null ? '' : `, Pick ${fmt(mon.pick)}`}`)}">
        <span class="dot" aria-hidden="true"></span>${escape(mon.name)}<span class="also-price tabular">${moneyShort(mon.price)}</span>
      </li>`;
  const shown = category.others.slice(0, CHIP_CAP).map(chipFor).join('');
  const rest = category.others.slice(CHIP_CAP);
  const more = rest.length
    ? `<details class="more"><summary>${rest.length} more</summary><ul class="also-list">${rest.map(chipFor).join('')}</ul></details>`
    : '';
  return `
    <div class="others">
      <h4 class="others-head">Also qualifies <span>${category.others.length}, strongest first</span></h4>
      <ul class="also-list">${shown}</ul>
      ${more}
    </div>`;
}

function section(category: Category): string {
  return `
  <section class="category" id="${category.key}" data-category>
    <header class="cat-head">
      <p class="kicker">${escape(category.kicker)}</p>
      <h3>${escape(category.title)}</h3>
      <p class="why">${escape(category.why)}</p>
    </header>
    <div class="cards">${category.cards.map(card).join('')}</div>
    <p class="empty-note" hidden>Nothing hand-scored here fits your filter. The list below may still have something.</p>
    ${others(category)}
  </section>`;
}

/** The categories a Pokémon is hand-scored in — its jobs, as a drafter reads them. */
function rolesOf(model: GuideModel, slug: string): string[] {
  return model.categories
    .filter((c) => !['budget', 'save-up'].includes(c.key) && c.cards.some((e) => e.mon.slug === slug))
    .map((c) => c.title);
}

function board(model: GuideModel): string {
  const top = model.mons
    .filter((m) => m.pick !== null)
    .sort((a, b) => b.pick! - a.pick! || b.power - a.power)
    .slice(0, 20);
  const rows = top
    .map(
      (m, i) => `
      <tr data-price="${m.price}" style="--tier:${TIER_COLOUR[m.tier]}">
        <td class="tabular num">${i + 1}</td>
        <th scope="row"><span class="who">${sprite(m, 36)}<span>${escape(m.name)}</span></span></th>
        <td>${chip(m)}</td>
        <td class="tabular">${moneyShort(m.price)}</td>
        <td class="tabular">${fmt(m.power)}</td>
        <td class="tabular">${fmt(m.value)}</td>
        <td class="tabular strong">${fmt(m.pick!)}</td>
        <td class="roles">${escape(rolesOf(model, m.slug).join(', ') || '—')}</td>
      </tr>`,
    )
    .join('');
  return `
  <section class="board" id="board" data-category>
    <header class="cat-head">
      <p class="kicker">All categories</p>
      <h3>Top of the board</h3>
      <p class="why">The twenty best draft picks by Pick score, whatever their role. The top of it is A+ Pokémon that take half your budget. Look for the B and C prices mixed in: those are the bargains.</p>
    </header>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">#</th><th scope="col">Pokémon</th><th scope="col">Tier</th><th scope="col">Price</th><th scope="col">Power</th><th scope="col">Value</th><th scope="col">Pick</th><th scope="col">Hand-scored for</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="empty-note" hidden>Nothing on the board fits your filter.</p>
  </section>`;
}

function squads(model: GuideModel): string {
  const cards = model.squads
    .map((s) => {
      const share = Math.min((s.total / model.budget) * 100, 100);
      const members = s.members
        .map(
          (m) => `
          <li style="--tier:${TIER_COLOUR[m.tier]}">
            ${sprite(m, 40)}
            <span class="sq-name">${escape(m.name)}${m.slug === s.mega ? ' <span class="mega-tag">Mega</span>' : ''}</span>
            <span class="sq-price tabular">${moneyShort(m.price)}</span>
          </li>`,
        )
        .join('');
      return `
      <article class="squad">
        <h4>${escape(s.name)}</h4>
        <p class="squad-idea">${escape(s.idea)}</p>
        <ul class="squad-list">${members}</ul>
        <div class="squad-total">
          <span class="track"><span class="fill budget" style="width:${share.toFixed(1)}%"></span></span>
          <span class="tabular"><strong>${money(s.total)}</strong> of ${money(model.budget)} · ${money(model.budget - s.total)} left</span>
        </div>
      </article>`;
    })
    .join('');
  return `
  <section class="category" id="squads">
    <header class="cat-head">
      <p class="kicker">Checked against the budget</p>
      <h3>Sample squads</h3>
      <p class="why">Four complete six-Pokémon drafts. Each costs no more than the ₽${model.budget.toLocaleString('en-US')} opening budget and plans on one Mega. The build checks both, so these add up. In a real draft someone will take one of these picks first, so treat them as shapes to copy, not shopping lists.</p>
    </header>
    <div class="squads">${cards}</div>
  </section>`;
}

function adjustments(model: GuideModel): string {
  const rows = model.mons
    .filter((m) => m.adjustment)
    .sort((a, b) => b.adjustment!.adjust - a.adjustment!.adjust)
    .map(
      (m) => `
      <tr>
        <th scope="row">${escape(m.name)}</th>
        <td class="tabular">#${m.rank}</td>
        <td class="tabular">${fmt(m.basePower)} → <strong>${fmt(m.power)}</strong></td>
        <td>${escape(m.adjustment!.why)}</td>
      </tr>`,
    )
    .join('');
  return `
    <h3 class="foot-head">Where the guide overrules the ladder</h3>
    <p>Power normally comes straight from the op.gg rank. These are the only exceptions, each for a mechanical reason the price band can't see. They are marked <strong>Power*</strong> on their cards.</p>
    <div class="table-wrap"><table class="adjust">
      <thead><tr><th scope="col">Pokémon</th><th scope="col">Rank</th><th scope="col">Power</th><th scope="col">Why</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function build(): string {
  const model = loadGuide();
  const { tierFile, budget } = model;
  const generated = new Date().toISOString().slice(0, 10);
  const inferredCount = model.mons.filter((m) => m.kit.learnsetFrom !== 'champions').length;

  const nav = [
    `<a href="#board">Top of the board</a>`,
    ...model.categories.map((c) => `<a href="#${c.key}">${escape(c.title)}</a>`),
    `<a href="#squads">Sample squads</a>`,
  ].join('');

  return `<title>Champions Draft Guide</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_LINKS}
<style>
  /*
   * The market sheet's look, on purpose: the two get read side by side on draft night — this
   * one to decide, that one to price. Dark on screen, ink on paper.
   */
${TOKENS_CSS}
  :root {
    --power: #ffcb05;
    --role: #ff7eb6;
    --value: #2ec4b6;
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 120px; }
  body {
    margin: 0;
    background: var(--surface);
    color: var(--ink);
    font-family: var(--body);
    font-size: 15px;
    line-height: 1.5;
    -webkit-text-size-adjust: 100%;
  }
  .page { max-width: 1180px; margin: 0 auto; padding: 40px 16px 64px; }
  .tabular { font-variant-numeric: tabular-nums; }

  /* --- masthead -------------------------------------------------------------------------- */
  .masthead { border-bottom: 2px solid var(--accent); padding-bottom: 20px; }
  .eyebrow, .kicker {
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
    margin: 0;
    text-wrap: balance;
  }
  .lede { color: var(--muted); margin: 12px 0 0; max-width: 68ch; }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px 24px;
    margin: 24px 0 0;
  }
  .facts div { display: flex; flex-direction: column; gap: 2px; }
  .facts dt, .legend dt {
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
    color: var(--muted);
  }
  .facts dd { margin: 0; font-size: 14px; }
  .facts a { color: var(--ink); text-decoration-color: var(--line); }

  /* --- the score legend ------------------------------------------------------------------ */
  .legend {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin: 28px 0 0;
  }
  .legend > div {
    background: var(--panel);
    border: 1px solid var(--line);
    border-top: 3px solid var(--c);
    border-radius: 6px;
    padding: 12px 14px;
  }
  .legend dt { color: var(--c); font-size: 13px; font-weight: 700; }
  .legend dd { margin: 4px 0 0; font-size: 13.5px; color: var(--ink); }
  .legend dd small { display: block; color: var(--muted); margin-top: 4px; font-size: 12px; }

  /* --- sticky toolbar -------------------------------------------------------------------- */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 10;
    margin: 28px -16px 0;
    padding: 10px 16px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line);
  }
  .nav {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: thin;
    padding-bottom: 6px;
  }
  .nav a {
    flex: none;
    font-family: var(--display);
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    text-decoration: none;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
  }
  .nav a:hover, .nav a:focus-visible { color: var(--ink); border-color: var(--accent); outline: none; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; font-size: 13px; color: var(--muted); }
  .filters label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .filters select {
    background: var(--panel-2);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 4px;
    font: inherit;
    padding: 3px 6px;
  }
  .filters input { accent-color: var(--accent); }
  .filters output { margin-left: auto; font-variant-numeric: tabular-nums; }

  /* --- categories ------------------------------------------------------------------------ */
  .category, .board { margin-top: 56px; }
  .cat-head { border-bottom: 2px solid var(--line); padding-bottom: 10px; margin-bottom: 16px; }
  .cat-head h3 {
    font-family: var(--display);
    font-size: clamp(28px, 5vw, 38px);
    font-weight: 700;
    margin: 0;
    line-height: 1;
  }
  .why { margin: 8px 0 0; color: var(--muted); max-width: 78ch; }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
    gap: 12px;
  }
  .card {
    position: relative;
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid var(--tier);
    border-radius: 6px;
    padding: 12px 14px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    break-inside: avoid;
  }
  .ordinal {
    position: absolute;
    top: 6px;
    left: -1px;
    transform: translateX(-50%);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--display);
    font-size: 11px;
    font-weight: 700;
    border: 1px solid var(--line);
    border-radius: 999px;
    min-width: 20px;
    text-align: center;
    line-height: 18px;
  }
  .card-head { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; }
  .sprite { image-rendering: pixelated; display: block; flex: none; }
  .sprite-empty { display: inline-block; }
  .card-name { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.25; }
  .card-meta { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }
  .card-meta strong { color: var(--ink); }
  .chip {
    display: inline-block;
    font-family: var(--display);
    font-weight: 700;
    font-size: 12px;
    padding: 0 6px;
    border-radius: 3px;
    color: #12141b;
    background: var(--tier);
    vertical-align: 2px;
  }
  .pick {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    line-height: 1;
  }
  .pick-num { font-family: var(--display); font-size: 20px; font-weight: 700; }
  .pick-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-top: 2px; }
  .pick.save { border-style: dashed; border-color: var(--muted); }
  .pick.save .pick-num { font-size: 13px; }

  .card-via { margin: 0; font-size: 12.5px; color: var(--ink); font-weight: 500; }
  .inferred {
    display: inline-block;
    margin-left: 4px;
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
    border: 1px dashed var(--line);
    border-radius: 3px;
    padding: 0 4px;
  }

  .bars { margin: 0; display: grid; gap: 4px; }
  .bar-row { display: grid; grid-template-columns: 52px 1fr; align-items: center; gap: 8px; }
  .bar-row dt { font-size: 11px; font-family: var(--display); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .bar-row dd { margin: 0; display: grid; grid-template-columns: 1fr 30px; align-items: center; gap: 8px; }
  .bar-row b { font-size: 13px; text-align: right; }
  .track { display: block; height: 7px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
  .fill { display: block; height: 100%; width: calc(var(--v) * 10%); border-radius: 4px; }
  .fill.power { background: var(--power); }
  .fill.role { background: var(--role); }
  .fill.value { background: var(--value); }
  .fill.budget { background: var(--accent); }

  .card-note { margin: 0; font-size: 13.5px; }
  .tags { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .tags li { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 5px; }

  .others { margin-top: 16px; }
  .others-head { margin: 0 0 8px; font-family: var(--display); text-transform: uppercase; letter-spacing: 0.1em; font-size: 12px; color: var(--muted); font-weight: 600; }
  .others-head span { text-transform: none; letter-spacing: 0; font-family: var(--body); font-weight: 400; }
  .also-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .also {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 10px 2px 8px;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tier); flex: none; }
  .also-price { color: var(--muted); font-size: 12px; }
  .more { margin-top: 8px; }
  .more summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .more .also-list { margin-top: 8px; }
  .empty-note { color: var(--muted); font-style: italic; }

  /* --- tables ---------------------------------------------------------------------------- */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 640px; }
  th, td { text-align: left; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); vertical-align: middle; }
  thead th {
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
  }
  .board tbody th { font-weight: 600; }
  .who { display: inline-flex; align-items: center; gap: 8px; }
  td.num { color: var(--muted); width: 28px; }
  td.strong { font-weight: 700; color: var(--accent); }
  td.roles { font-size: 12.5px; color: var(--muted); }

  /* --- squads ---------------------------------------------------------------------------- */
  .squads { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 12px; }
  .squad { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px; break-inside: avoid; }
  .squad h4 { margin: 0; font-family: var(--display); font-size: 22px; }
  .squad-idea { margin: 6px 0 10px; font-size: 13.5px; color: var(--muted); }
  .squad-list { list-style: none; margin: 0; padding: 0; }
  .squad-list li {
    display: grid;
    grid-template-columns: 40px 1fr auto;
    align-items: center;
    gap: 8px;
    border-left: 3px solid var(--tier);
    padding: 2px 0 2px 8px;
    margin-bottom: 4px;
  }
  .sq-price { color: var(--muted); }
  .mega-tag { font-size: 10px; font-weight: 700; padding: 0 4px; border-radius: 3px; background: var(--accent); color: #12141b; vertical-align: 1px; }
  .squad-total { margin-top: 10px; display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
  .squad-total strong { color: var(--ink); }
  .squad-total .track { height: 9px; }

  /* --- footer ---------------------------------------------------------------------------- */
  footer { margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13.5px; }
  footer p { margin: 0 0 8px; max-width: 90ch; }
  .foot-head { font-family: var(--display); font-size: 20px; color: var(--ink); margin: 24px 0 6px; }
  table.adjust { min-width: 560px; }
  table.adjust td:last-child { color: var(--ink); }
  code { font-size: 12.5px; }

  [hidden] { display: none !important; }

  @media (max-width: 520px) {
    .toolbar { padding-inline: 16px; }
    .filters output { margin-left: 0; width: 100%; }
    .pick { width: 46px; height: 46px; }
  }

  /* --- print ----------------------------------------------------------------------------- */
  @media print {
    :root { --surface: #fff; --panel: #fff; --panel-2: #eee; --line: #d8d8d8; --ink: #111; --muted: #555; --accent: #b38f00; --power: #c9a000; --role: #d6457f; --value: #178f85; }
    body { font-size: 10pt; }
    .page { padding: 0; max-width: none; }
    .toolbar { display: none; }
    .category, .board { margin-top: 28px; break-before: page; }
    .cards { grid-template-columns: repeat(2, 1fr); }
    .card, .squad, .legend > div { break-inside: avoid; }
    .chip, .mega-tag { color: #111; border: 1px solid #0003; }
    .more { display: none; }
    a { text-decoration: none; color: inherit; }
    @page { margin: 12mm; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
  }
</style>

<main class="page">
  <header class="masthead">
    <p class="eyebrow">Pokémon Champions · Fantasy League</p>
    <h1>Draft Guide</h1>
    <p class="lede">
      The doubles roles that win matches, the best Pokémon for each, and what each one is worth
      to draft. Every S-tier costs more than the whole ${money(budget)} opening budget, so the draft is
      fought over A+ stars and the bargains below them. This guide is built to find those bargains.
    </p>
    <dl class="facts">
      <div><dt>Opening budget</dt><dd>${money(budget)} · ${LEAGUE_DEFAULTS.draftRounds} snake rounds</dd></div>
      <div><dt>Ladder</dt><dd><a href="${escape(tierFile.sourceUrl ?? '#')}">op.gg doubles</a>, captured ${escape(tierFile.updated)}</dd></div>
      <div><dt>Pokémon</dt><dd>${model.total} tradable · ${model.mons.filter((m) => m.pick !== null).length} draftable</dd></div>
      <div><dt>Moves read from</dt><dd>PokéAPI Champions learnsets${inferredCount ? ` (${inferredCount} stand-ins)` : ''}</dd></div>
      <div><dt>Guide generated</dt><dd>${generated}</dd></div>
    </dl>
    <dl class="legend">
      <div style="--c:var(--role)"><dt>Role · 1–10</dt><dd>How good it is at <em>this</em> category's job. Hand-scored. <small>A 10 is the Pokémon the job is named after.</small></dd></div>
      <div style="--c:var(--power)"><dt>Power · 1–10</dt><dd>How good it is overall, from its op.gg doubles rank. <small>#1 is 10, last is 1. <strong>Power*</strong> means the guide overruled the ladder; see the footer.</small></dd></div>
      <div style="--c:var(--value)"><dt>Value · 1–10</dt><dd>Power for the price. 5 is the going rate. <small>Computed, so it moves with every reprice. Top-of-tier Pokémon score high.</small></dd></div>
      <div style="--c:var(--accent)"><dt>Pick · 1–10</dt><dd>Draft priority: 60% Power, 40% Value. <small><strong>Save up</strong> means it costs more than the opening budget: buy it later, from wins.</small></dd></div>
    </dl>
  </header>

  <div class="toolbar">
    <nav class="nav" aria-label="Categories">${nav}</nav>
    <div class="filters">
      <label><input type="checkbox" id="draftOnly"> Only what I can draft</label>
      <label>Price cap
        <select id="cap">
          <option value="0">Any price</option>
          <option value="250000">₽250k</option>
          <option value="150000">₽150k</option>
          <option value="100000">₽100k</option>
          <option value="60000">₽60k</option>
          <option value="30000">₽30k</option>
        </select>
      </label>
      <output id="shown" aria-live="polite"></output>
    </div>
  </div>

  ${board(model)}
  ${model.categories.map(section).join('')}
  ${squads(model)}

  <footer>
    <h3 class="foot-head">How this is built</h3>
    <p><strong>Who qualifies</strong> for a category comes from data: moves and abilities from PokéAPI's Champions learnsets, pooled across forms (so Indeedee counts the female's Follow Me), plus Mega abilities. Where PokéAPI has no Champions learnset yet, the card says which game stands in.</p>
    <p><strong>Role</strong> scores and notes are judgement, written in <code>data/draft-guide.json</code>. So is the handful of Power adjustments below. If your read of the meta differs, change the file and rerun. <strong>Value</strong> fits log(price) against Power across all ${model.total} Pokémon and scores each on how far below the line it sits. <strong>Pick</strong> is 60% Power and 40% Value.</p>
    ${adjustments(model)}
    <p style="margin-top:20px">Regenerate with <code>npm run guide:doc</code>, which runs as part of <code>npm run market:update</code>. Prices come from <code>data/roster.json</code>. Tier source: ${escape(tierFile.source)}.</p>
  </footer>
</main>

<script>
(function () {
  var BUDGET = ${budget};
  var KEY = 'pkf.guide.filters.v1';
  var draftOnly = document.getElementById('draftOnly');
  var cap = document.getElementById('cap');
  var shown = document.getElementById('shown');

  // Storage is a convenience: a private window throws, and the page must work anyway.
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    draftOnly.checked = !!saved.draftOnly;
    if (saved.cap) cap.value = String(saved.cap);
  } catch (e) {}

  function apply() {
    var limit = +cap.value || Infinity;
    if (draftOnly.checked) limit = Math.min(limit, BUDGET);
    var visible = 0;
    var total = 0;
    document.querySelectorAll('[data-price]').forEach(function (el) {
      var ok = +el.dataset.price <= limit;
      el.hidden = !ok;
      if (el.classList.contains('card')) { total++; if (ok) visible++; }
    });
    document.querySelectorAll('[data-category]').forEach(function (sec) {
      var note = sec.querySelector('.empty-note');
      if (!note) return;
      var any = sec.querySelector('.card:not([hidden]), tbody tr:not([hidden])');
      note.hidden = !!any;
    });
    shown.textContent = limit === Infinity ? '' : visible + ' of ' + total + ' cards shown';
    try { localStorage.setItem(KEY, JSON.stringify({ draftOnly: draftOnly.checked, cap: +cap.value })); } catch (e) {}
  }

  draftOnly.addEventListener('change', apply);
  cap.addEventListener('change', apply);
  apply();
})();
</script>
`;
}

const html = build();
writeFileSync(join(ROOT, 'data/draft-guide.html'), html);
console.log(`Wrote data/draft-guide.html (${(html.length / 1024).toFixed(0)} KB). Open it, or print to PDF.`);
