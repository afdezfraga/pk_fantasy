/** The vocabulary of a drawn club crest. Shared by the editor, the renderer and validation. */

export const CREST_SHAPES = ['shield', 'round', 'diamond', 'banner'] as const;
export type CrestShape = (typeof CREST_SHAPES)[number];

/** Emblems that aren't a Pokémon: drawn as a glyph in the middle of the crest. */
export const CREST_GLYPHS: Record<string, string> = {
  star: '★',
  bolt: '⚡',
  flame: '🔥',
  leaf: '🍃',
  drop: '💧',
  ball: '◉',
  crown: '♛',
  fist: '✊',
};

/** Kit colours to pick from. Deliberately few: a short list makes a club look like a club. */
export const CREST_COLOURS = [
  '#1f2ec8',
  '#2f49ff',
  '#e11f2b',
  '#f7d20c',
  '#ffcb05',
  '#0f9d58',
  '#12b886',
  '#7b2ff7',
  '#ff6b00',
  '#e8eaf6',
  '#111827',
  '#8d6e63',
] as const;
