/**
 * A club's crest.
 *
 * Drawn as an SVG from four fields on the team — shape, two colours, an emblem and up to three
 * letters — so every club has one from the moment it is created, with nothing to upload and
 * nothing to store. A team that would rather use its own badge uploads an image, and that wins.
 *
 * The drawn crest is deliberately simple geometry: it has to read at 24px in a standings row as
 * well as at 150px on the club page.
 */

import { CREST_GLYPHS } from '../../config/crest.ts';

export interface Crest {
  name: string;
  shape: string;
  primary: string;
  secondary: string;
  /** A Pokémon slug, a key of CREST_GLYPHS, or null. */
  emblem: string | null;
  initials: string | null;
  /** Set when the team uploaded its own image; then that is the crest. */
  imageUrl?: string | null;
}

/** Up to three letters, from the club's own initials when it hasn't chosen any. */
export function crestInitials(crest: Pick<Crest, 'name' | 'initials'>): string {
  const chosen = crest.initials?.trim();
  if (chosen) return chosen.slice(0, 3).toUpperCase();
  return crest.name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

/** The outline of each shape, on a 100×100 canvas. */
function outline(shape: string): string {
  switch (shape) {
    case 'round':
      return 'M50 3 A47 47 0 1 1 49.9 3 Z';
    case 'diamond':
      return 'M50 2 L96 50 L50 98 L4 50 Z';
    case 'banner':
      return 'M8 6 H92 V74 L50 96 L8 74 Z';
    default:
      // A football shield: square shoulders, curved base.
      return 'M8 6 H92 V52 C92 76 74 90 50 97 C26 90 8 76 8 52 Z';
  }
}

export function ClubCrest({
  crest,
  size = 40,
  className = '',
}: {
  crest: Crest;
  size?: number;
  className?: string;
}) {
  const label = `${crest.name} crest`;

  if (crest.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={crest.imageUrl}
        alt={label}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={`shrink-0 object-contain ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }

  const letters = crestInitials(crest);
  const glyph = crest.emblem ? CREST_GLYPHS[crest.emblem] : undefined;
  // Anything that isn't a known glyph key is a Pokémon slug, drawn from its sprite.
  const sprite =
    crest.emblem && !glyph
      ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/${crest.emblem}.png`
      : null;
  const path = outline(crest.shape);
  const clipId = `crest-clip-${crest.shape}`;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={`shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={path} />
        </clipPath>
      </defs>

      <path d={path} fill={crest.primary} />
      {/* A diagonal sash in the second colour, clipped to the shape. */}
      <path
        d="M-20 70 L70 -20 L100 10 L10 100 Z"
        fill={crest.secondary}
        opacity="0.9"
        clipPath={`url(#${clipId})`}
      />
      <path d={path} fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="4" />

      {sprite ? (
        // eslint-disable-next-line @next/next/no-img-element
        <image href={sprite} x="22" y="14" width="56" height="56" preserveAspectRatio="xMidYMid meet" />
      ) : (
        <text
          x="50"
          y={letters ? '46' : '56'}
          textAnchor="middle"
          fontSize={glyph ? '40' : '34'}
          fontWeight="800"
          fill="#fff"
          stroke="rgba(0,0,0,0.5)"
          strokeWidth="1"
          paintOrder="stroke"
        >
          {glyph ?? letters}
        </text>
      )}

      {(sprite || glyph) && letters && (
        <text
          x="50"
          y="86"
          textAnchor="middle"
          fontSize="20"
          fontWeight="800"
          fill="#fff"
          stroke="rgba(0,0,0,0.5)"
          strokeWidth="1"
          paintOrder="stroke"
        >
          {letters}
        </text>
      )}
    </svg>
  );
}

/** The crest fields a team row carries, in the shape `ClubCrest` wants. */
export function crestOf(team: {
  id?: string;
  name: string;
  crestShape: string;
  crestPrimary: string;
  crestSecondary: string;
  crestEmblem: string | null;
  crestInitials: string | null;
  crestMime?: string | null;
  crestUpdatedAt?: Date | null;
}): Crest {
  return {
    name: team.name,
    shape: team.crestShape,
    primary: team.crestPrimary,
    secondary: team.crestSecondary,
    emblem: team.crestEmblem,
    initials: team.crestInitials,
    // Cache-busted on the upload time, so a new badge shows up immediately.
    imageUrl:
      team.crestMime && team.id
        ? `/api/crest/${team.id}?v=${team.crestUpdatedAt?.getTime() ?? 0}`
        : null,
  };
}
