/**
 * Club identity: the crest, and who captains the squad.
 *
 * An uploaded crest is the one thing in the app that accepts a file, so it is also the one place
 * that has to be careful: only real raster images, checked by their magic bytes rather than by
 * what the browser claims, and small enough that the database stays a file you can copy.
 */

import { db } from '../db.ts';
import { CREST_SHAPES } from '../../config/crest.ts';

export class ClubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClubError';
  }
}

/** 256KB. A crest is a badge, not a wallpaper. */
export const MAX_CREST_BYTES = 256 * 1024;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * What kind of image these bytes actually are, or null.
 *
 * Deliberately sniffed rather than trusted: the upload's own content type is whatever the client
 * chose to send. SVG is not on the list on purpose — an SVG is a document that can carry script,
 * and this one would be served from our own origin.
 */
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export interface CrestInput {
  shape: string;
  primary: string;
  secondary: string;
  emblem: string | null;
  initials: string | null;
  /** The uploaded file, if one came with the form. */
  image?: Uint8Array | null;
  /** True when the team asked to go back to the drawn crest. */
  removeImage?: boolean;
}

export async function updateCrest(input: CrestInput & { teamId: string; userId: string }) {
  const team = await db.team.findUnique({ where: { id: input.teamId } });
  if (!team) throw new ClubError('No such team.');
  if (team.userId !== input.userId) throw new ClubError('That club is not yours.');

  if (!CREST_SHAPES.includes(input.shape as (typeof CREST_SHAPES)[number])) {
    throw new ClubError('Pick one of the crest shapes.');
  }
  for (const colour of [input.primary, input.secondary]) {
    if (!HEX.test(colour)) throw new ClubError('Crest colours must be hex, like #1f2ec8.');
  }

  const initials = input.initials?.trim().slice(0, 3).toUpperCase() || null;
  if (initials && !/^[A-Z0-9]+$/.test(initials)) {
    throw new ClubError('Initials can only be letters and numbers.');
  }

  let image: { crestImage: Uint8Array<ArrayBuffer> | null; crestMime: string | null } | null = null;
  if (input.image && input.image.length > 0) {
    if (input.image.length > MAX_CREST_BYTES) {
      throw new ClubError(`That image is over ${Math.round(MAX_CREST_BYTES / 1024)}KB.`);
    }
    const mime = sniffImage(input.image);
    if (!mime) throw new ClubError('Upload a PNG, JPEG or WebP image.');
    // Copied into a plain ArrayBuffer: what arrives from a form may be a view on a larger,
    // shared buffer.
    const bytes = new Uint8Array(new ArrayBuffer(input.image.length));
    bytes.set(input.image);
    image = { crestImage: bytes, crestMime: mime };
  } else if (input.removeImage) {
    image = { crestImage: null, crestMime: null };
  }

  return db.team.update({
    where: { id: input.teamId },
    data: {
      crestShape: input.shape,
      crestPrimary: input.primary,
      crestSecondary: input.secondary,
      crestEmblem: input.emblem?.trim() || null,
      crestInitials: initials,
      ...(image ?? {}),
      ...(image ? { crestUpdatedAt: new Date() } : {}),
    },
  });
}

/**
 * Hands the armband to another Pokémon in the squad.
 *
 * The captain is mostly presentation — the armband on the card and the name in the header —
 * though events weigh heavier on it. A club with Pokémon always has one: the first signing
 * takes it and a sale passes it on (see `ensureCaptain`), so it can be moved but not removed.
 */
export async function setCaptain(input: { leagueId: string; teamId: string; pokemonSlug: string }) {
  return db.$transaction(async (tx) => {
    const target = await tx.ownership.findUnique({
      where: {
        leagueId_pokemonSlug: { leagueId: input.leagueId, pokemonSlug: input.pokemonSlug },
      },
    });
    if (!target || target.teamId !== input.teamId) {
      throw new ClubError("That Pokémon isn't on your squad.");
    }

    await tx.ownership.updateMany({
      where: { leagueId: input.leagueId, teamId: input.teamId, captain: true },
      data: { captain: false, captainSince: null },
    });
    // The clock starts again. Events that ask for a settled dressing room are asking about
    // this date, so handing the armband around has a cost that is not merely cosmetic.
    await tx.ownership.update({
      where: { id: target.id },
      data: { captain: true, captainSince: new Date() },
    });
    return { captain: input.pokemonSlug };
  });
}
