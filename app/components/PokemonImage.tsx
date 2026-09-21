/**
 * Pokémon artwork, in the two sizes the app actually uses.
 *
 * Deliberately plain `<img>` rather than `next/image`: the market lists all 247 Pokémon at once,
 * and the optimizer would be asked for 247 transforms of images that are already the right size
 * and a few kilobytes each. Explicit width/height keep long lists from reflowing as they load.
 *
 * `PokemonIcon` is the 96px game sprite — cheap enough to put on every row of a long list.
 * `PokemonArt` is the Pokémon HOME render, for the handful of cards on screen at once.
 */

function Placeholder({ size, rounded }: { size: number; rounded: string }) {
  return (
    <span
      className={`inline-block shrink-0 bg-panel-2 ${rounded}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

export function PokemonIcon({
  icon,
  alt,
  size = 36,
  className = '',
}: {
  icon: string | null;
  alt: string;
  size?: number;
  className?: string;
}) {
  if (!icon) return <Placeholder size={size} rounded="rounded-md" />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={icon}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function PokemonArt({
  home,
  icon,
  alt,
  size = 72,
  className = '',
}: {
  home: string | null;
  /** Fallback for the few Pokémon HOME hasn't catalogued (new Legends: Z-A Megas). */
  icon?: string | null;
  alt: string;
  size?: number;
  className?: string;
}) {
  const src = home ?? icon ?? null;
  if (!src) return <Placeholder size={size} rounded="rounded-lg" />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
