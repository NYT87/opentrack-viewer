import { useId, useMemo, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatDistance, type UnitSystem } from '../domain/units';
import {
  PRIVACY_TRIM_MAX_SHARE,
  PRIVACY_TRIM_STEP_PERCENT,
  keptRoute,
  minimumKeptText,
  readPrivacyTrim,
  routeTotalMeters,
  type PrivacyTrim,
} from '../overlay/privacyTrim';

interface PrivacyTrimFieldProps {
  trim: PrivacyTrim | undefined;
  onChange: (trim: PrivacyTrim | undefined) => void;
  /** The route the shares are of: the distance each hides is written beside it. */
  activity: Activity | undefined;
  units: UnitSystem;
}

const MAX_PERCENT = PRIVACY_TRIM_MAX_SHARE * 100;
/** A share in percent, to the control's step: no float noise in what is shown or typed back. */
const toPercent = (share: number) => Math.round(share * 1000) / 10;
const toShare = (percent: number) => Math.round(percent * 10) / 1000;
const clampPercent = (percent: number) => Math.min(MAX_PERCENT, Math.max(0, percent));

/**
 * AV-1022 (TD-091). The overlay's privacy trim: how much of the route's start and end to hide, by
 * two handles along the route or two percentages, kept in step both ways. Each end hides at most
 * 45 %, so the two handles can never cross. One control for the template overlay, the custom canvas
 * and the still image.
 */
export function PrivacyTrimField({ trim, onChange, activity, units }: PrivacyTrimFieldProps) {
  const id = useId();
  const start = toPercent(trim?.start ?? 0);
  const end = toPercent(trim?.end ?? 0);
  const total = useMemo(() => (activity ? routeTotalMeters(activity) : 0), [activity]);
  const kept = useMemo(() => keptRoute(activity, trim), [activity, trim]);
  /** What is being typed, so "1" on the way to "12" is not rewritten under the reader's hands; it is shown only while it still says what the share is (a reset or an opened layout changes the share under it). */
  const [draft, setDraft] = useState<{ which: 'start' | 'end'; text: string } | undefined>();

  const set = (next: { start?: number; end?: number }) => onChange(readPrivacyTrim({ start: toShare(next.start ?? start), end: toShare(next.end ?? end) }));
  const typed = (which: 'start' | 'end', text: string) => {
    const value = Number(text);
    const usable = text.trim() !== '' && Number.isFinite(value);
    // A value the field cannot hold (past 45 %, or finer than a tenth) is shown as the share it became, so the input never says what the handle and the description do not.
    setDraft(usable && toPercent(clampPercent(value) * 0.01) !== value ? undefined : { which, text });
    if (usable) set({ [which]: clampPercent(value) });
  };
  const beside = (percent: number) => (total > 0 ? `${percent} % — ${formatDistance((percent / 100) * total, units)}` : `${percent} %`);

  const field = (which: 'start' | 'end', label: string, percent: number) => (
    <div className="overlay-controls__field">
      <label htmlFor={`${id}-${which}`}>{label}</label>
      <input
        id={`${id}-${which}`}
        className="input privacy-trim__number"
        type="number"
        inputMode="decimal"
        min={0}
        max={MAX_PERCENT}
        step={PRIVACY_TRIM_STEP_PERCENT}
        value={draft?.which === which && (draft.text.trim() === '' || clampPercent(Number(draft.text)) === percent) ? draft.text : String(percent)}
        aria-describedby={`${id}-${which}-beside`}
        onChange={(event) => typed(which, event.target.value)}
        onBlur={() => setDraft(undefined)}
      />
      <span id={`${id}-${which}-beside`} className="overlay-controls__value privacy-trim__beside">
        {beside(percent)}
      </span>
    </div>
  );

  return (
    <fieldset className="overlay-controls__group privacy-trim">
      <legend>Privacy trim</legend>
      <p className="overlay-controls__hint">
        Hides the start and the end of the route from the route drawn, its marker and the route image, so they need not show where you
        set off or finish. Figures such as speed and distance are not places and keep showing.
      </p>
      <div className="privacy-trim__slider" role="group" aria-label="The part of the route kept">
        <div className="privacy-trim__track" aria-hidden="true">
          <div className="privacy-trim__kept" style={{ left: `${start}%`, right: `${end}%` }} />
        </div>
        <input
          type="range"
          className="privacy-trim__handle privacy-trim__handle--start"
          aria-label="Start of the route kept"
          aria-valuetext={`Hiding the first ${beside(start)}`}
          min={0}
          max={MAX_PERCENT}
          step={PRIVACY_TRIM_STEP_PERCENT}
          value={start}
          onChange={(event) => {
            setDraft(undefined);
            set({ start: clampPercent(Number(event.target.value)) });
          }}
        />
        <input
          type="range"
          className="privacy-trim__handle privacy-trim__handle--end"
          aria-label="End of the route kept"
          aria-valuetext={`Hiding the last ${beside(end)}`}
          min={100 - MAX_PERCENT}
          max={100}
          step={PRIVACY_TRIM_STEP_PERCENT}
          value={Math.round((100 - end) * 10) / 10}
          onChange={(event) => {
            setDraft(undefined);
            set({ end: clampPercent(100 - Number(event.target.value)) });
          }}
        />
      </div>
      {field('start', 'Hide from the start (%)', start)}
      {field('end', 'Hide from the end (%)', end)}
      {kept?.tooShort && (
        <p className="overlay-controls__note" role="status">
          Less than {minimumKeptText(units)} of the route would be left, so it is not drawn.
        </p>
      )}
      {trim && (
        <p>
          <button type="button" className="button" onClick={() => onChange(undefined)}>
            Show the whole route
          </button>
        </p>
      )}
    </fieldset>
  );
}
