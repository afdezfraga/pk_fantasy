'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { CREST_COLOURS, CREST_GLYPHS, CREST_SHAPES } from '../../../../config/crest.ts';
import { updateCrestAction, type ActionState } from '../../../actions/market.ts';
import { ClubCrest, type Crest } from '../../../components/ClubCrest.tsx';
import { Button, Field, inputClass } from '../../../components/ui.tsx';

/**
 * The crest editor: pick a shape, two colours, an emblem and the letters, and watch it change.
 *
 * The preview is the same component that renders the crest everywhere else, so what you're
 * choosing is literally what you'll get. Uploading your own badge is the escape hatch for clubs
 * that already have one.
 */

function Save() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save crest'}
    </Button>
  );
}

function Swatches({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (colour: string) => void;
  label: string;
}) {
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {CREST_COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            onClick={() => onChange(colour)}
            aria-label={colour}
            aria-pressed={value.toLowerCase() === colour.toLowerCase()}
            className={`h-7 w-7 rounded-md border-2 transition ${
              value.toLowerCase() === colour.toLowerCase()
                ? 'border-accent'
                : 'border-transparent hover:border-line'
            }`}
            style={{ backgroundColor: colour }}
          />
        ))}
      </div>
    </div>
  );
}

export function CrestEditor({
  leagueId,
  crest,
  squad,
  hasUpload,
}: {
  leagueId: string;
  crest: Crest;
  /** The squad, so a club can put one of its own Pokémon on the badge. */
  squad: { slug: string; label: string }[];
  hasUpload: boolean;
}) {
  const [shape, setShape] = useState(crest.shape);
  const [primary, setPrimary] = useState(crest.primary);
  const [secondary, setSecondary] = useState(crest.secondary);
  const [emblem, setEmblem] = useState(crest.emblem ?? '');
  const [initials, setInitials] = useState(crest.initials ?? '');
  const [removeImage, setRemoveImage] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(updateCrestAction, {});

  const preview: Crest = {
    name: crest.name,
    shape,
    primary,
    secondary,
    emblem: emblem || null,
    initials: initials || null,
    imageUrl: hasUpload && !removeImage ? crest.imageUrl : null,
  };

  return (
    <form action={action} className="flex flex-col gap-4 sm:flex-row sm:gap-6">
      <input type="hidden" name="leagueId" value={leagueId} />
      <input type="hidden" name="shape" value={shape} />
      <input type="hidden" name="primary" value={primary} />
      <input type="hidden" name="secondary" value={secondary} />
      <input type="hidden" name="emblem" value={emblem} />
      <input type="hidden" name="removeImage" value={removeImage ? '1' : '0'} />

      <div className="flex shrink-0 flex-col items-center gap-2">
        <ClubCrest crest={preview} size={128} />
        <span className="text-xs text-muted">Preview</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <span className="mb-1 block text-sm font-medium text-ink">Shape</span>
          <div className="flex flex-wrap gap-1">
            {CREST_SHAPES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setShape(option)}
                aria-pressed={shape === option}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition ${
                  shape === option ? 'bg-accent text-accent-ink' : 'bg-panel-2 text-muted hover:text-ink'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Swatches label="Main colour" value={primary} onChange={setPrimary} />
          <Swatches label="Second colour" value={secondary} onChange={setSecondary} />
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium text-ink">Emblem</span>
          <select
            value={emblem}
            onChange={(event) => setEmblem(event.target.value)}
            className={inputClass}
          >
            <option value="">Just the letters</option>
            <optgroup label="Symbols">
              {Object.entries(CREST_GLYPHS).map(([key, glyph]) => (
                <option key={key} value={key}>
                  {glyph} {key}
                </option>
              ))}
            </optgroup>
            {squad.length > 0 && (
              <optgroup label="Your squad">
                {squad.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <Field label="Letters" hint="Up to three. Blank uses your club's initials.">
          <input
            name="initials"
            value={initials}
            onChange={(event) => setInitials(event.target.value.toUpperCase().slice(0, 3))}
            className={inputClass}
            placeholder={crest.name.slice(0, 3).toUpperCase()}
          />
        </Field>

        <Field label="Or upload your own" hint="PNG, JPEG or WebP, up to 256KB. It replaces the drawn crest.">
          <input
            type="file"
            name="image"
            accept="image/png,image/jpeg,image/webp"
            className="w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-panel-2 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-ink"
          />
        </Field>

        {hasUpload && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={removeImage}
              onChange={(event) => setRemoveImage(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Remove the uploaded badge and go back to the drawn one
          </label>
        )}

        {state.error && <p className="text-sm text-negative">{state.error}</p>}
        {state.success && <p className="text-sm text-positive">{state.success}</p>}

        <div>
          <Save />
        </div>
      </div>
    </form>
  );
}
