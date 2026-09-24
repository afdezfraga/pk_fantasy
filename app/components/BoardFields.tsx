import { LEAGUE_DEFAULTS } from '../../config/economy.ts';
import { Field, inputClass } from './ui.tsx';

/**
 * The event board's three dials, shared by the create-league form and the commissioner's
 * settings, so a league is set up and later adjusted with the same words.
 */
export function BoardFields({
  values = LEAGUE_DEFAULTS,
}: {
  values?: { eventBoardHours: number; eventBoardSize: number; eventBidMax: number };
}) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <Field label="Open for (hours)" hint="How long bids run before the board closes.">
        <input
          name="eventBoardHours"
          type="number"
          min={1}
          max={336}
          step={1}
          defaultValue={values.eventBoardHours}
          className={inputClass}
        />
      </Field>
      <Field label="Events per board" hint="How many go up each time.">
        <input
          name="eventBoardSize"
          type="number"
          min={1}
          max={6}
          step={1}
          defaultValue={values.eventBoardSize}
          className={inputClass}
        />
      </Field>
      <Field label="Highest bid (₽)" hint="The most a club may ask to be paid.">
        <input
          name="eventBidMax"
          type="number"
          min={1000}
          step={1000}
          defaultValue={values.eventBidMax}
          className={inputClass}
        />
      </Field>
    </div>
  );
}
