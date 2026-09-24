/**
 * What the league's printed documents share: the market sheet (`tiers:doc`), the draft guide
 * (`guide:doc`) and the draft report (`guide:report`). One place for the tier colours and the
 * design tokens, so a Pokémon reads the same colour on every page and in the app.
 */

import type { Tier } from '../config/economy.ts';

/** The app's tier colours, so a Pokémon reads the same here as on the market page. */
export const TIER_COLOUR: Record<Tier, string> = {
  S: '#ff5c5c',
  'A+': '#ff9f43',
  A: '#ffd93d',
  B: '#6bcb77',
  C: '#4d96ff',
  D: '#9b8fd6',
  UR: '#6b7280',
};

export const money = (n: number) => `₽${n.toLocaleString('en-US')}`;

/** "₽54k" — for cards and chips, where the full figure is noise. */
export const moneyShort = (n: number) =>
  n >= 1000 ? `₽${Math.round(n / 1000).toLocaleString('en-US')}k` : `₽${n}`;

export const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap">`;

/** The dark design tokens every document starts from. Print stylesheets override them. */
export const TOKENS_CSS = `  :root {
    --surface: #0f1117;
    --panel: #171a23;
    --panel-2: #1e222e;
    --line: #2a2f3d;
    --ink: #e8eaf0;
    --muted: #949cb0;
    --accent: #ffcb05;
    --display: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif;
    --body: 'Barlow', system-ui, -apple-system, 'Segoe UI', sans-serif;
  }`;

/** "tier-aplus" — the market sheet's anchor for a tier, so other pages can link straight to it. */
export const tierAnchor = (tier: Tier) => `tier-${tier.toLowerCase().replace('+', 'plus')}`;

/**
 * The way back to the landing page (`site:doc`). The documents are published side by side, and
 * also sit side by side in `data/`, so a relative link works in both places. Paper has nowhere to
 * go back to, so it doesn't print.
 */
export const HOME_CSS = `  .home {
    display: inline-block;
    margin-bottom: 14px;
    font-family: var(--display);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 12px;
    color: var(--muted);
    text-decoration: none;
  }
  .home:hover, .home:focus-visible { color: var(--accent); }
  @media print { .home { display: none; } }`;

export const HOME_LINK = `<a class="home" href="index.html">← League home</a>`;
