import { describe, expect, it } from 'vitest';

import { MAX_CREST_BYTES, sniffImage } from './club.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('crest uploads', () => {
  it('recognises the three formats a browser can actually draw', () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe('image/png');
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe('image/jpeg');
    expect(
      sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)),
    ).toBe('image/webp');
  });

  // An SVG is a document that can carry script, and it would be served from our own origin.
  it('refuses an SVG however it is labelled', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffImage(svg)).toBeNull();
  });

  it('refuses anything that is not an image at all', () => {
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(sniffImage(bytes())).toBeNull();
  });

  it('keeps the limit small enough that the database stays a file you can copy', () => {
    expect(MAX_CREST_BYTES).toBeLessThanOrEqual(512 * 1024);
  });
});
