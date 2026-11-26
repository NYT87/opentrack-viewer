import { stillValue, summaryValue, type StillImageContext } from '../overlay/staticImage';
import { sanitizeLabel, type OverlayComponent } from '../overlay/template';
import { supportedLocale } from '../overlay/dateFormat';

/**
 * AV-1032 (TD-104). The reader's own words on a still image or a canvas: a figure's caption, its decimal
 * places and its own value, and a date's language and its own text. Shared by both editors.
 */

type Change = (change: (component: OverlayComponent) => OverlayComponent) => void;

const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ca', 'pl', 'sv', 'ja', 'zh', 'ko', 'ar'];
/** The decimals a clock figure ignores. */
const CLOCKS = ['elapsed', 'moving', 'pace'];

/** Each language in its own, the browser's first. */
function languageChoices(current: string): { tag: string; name: string }[] {
  const browser = typeof navigator === 'undefined' ? undefined : supportedLocale(navigator.language);
  const tags = [...new Set([browser, ...LANGUAGES, current].filter((tag): tag is string => !!tag))];
  return tags.map((tag) => {
    let name = tag;
    try {
      name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
    } catch {
      /* a tag without a name is shown as it is */
    }
    return { tag, name };
  });
}

/** The words for "Write my own value": the checkbox, the field, the mark and the way back. */
function OwnValueField({
  id,
  label,
  component,
  context,
  own,
  setOwn,
}: {
  id: string;
  label: string;
  component: OverlayComponent;
  context: StillImageContext;
  own: string | undefined;
  setOwn: (own: string | undefined) => void;
}) {
  const computed = () => {
    const value = stillValue(stripOwn(component), context);
    return value.ok ? value.value : '';
  };
  return (
    <>
      <label className="overlay-controls__choice">
        <input id={`${id}-own-toggle`} type="checkbox" checked={own !== undefined} onChange={(event) => setOwn(event.target.checked ? computed() : undefined)} />
        <span>{label}</span>
      </label>
      {own !== undefined && (
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-own`}>Your text</label>
          <input id={`${id}-own`} className="input" type="text" aria-describedby={`${id}-own-hint`} value={own} onChange={(event) => setOwn(sanitizeLabel(event.target.value))} />
          <p id={`${id}-own-hint`} className="overlay-controls__hint">
            Edited by hand: drawn as written, never recalculated.{' '}
            <button type="button" className="button" onClick={() => {
                setOwn(undefined);
                // The button leaves with the field; keep the keyboard in the editor.
                document.getElementById(`${id}-own-toggle`)?.focus();
              }}
            >
              Use the activity’s value
            </button>
          </p>
        </div>
      )}
    </>
  );
}

const stripOwn = (component: OverlayComponent): OverlayComponent => ({
  ...component,
  ...(component.summary ? { summary: { ...component.summary, ownValue: undefined } } : {}),
  ...(component.date ? { date: { ...component.date, ownValue: undefined } } : {}),
});

export function SummaryFields({
  id,
  component,
  context,
  onChange,
}: {
  id: string;
  component: OverlayComponent;
  context: StillImageContext;
  onChange: Change;
}) {
  const setting = component.summary;
  if (!setting) return null;
  const set = (patch: Partial<typeof setting>) => onChange((c) => ({ ...c, summary: { ...(c.summary ?? setting), ...patch } }));
  const app = summaryValue(setting.stat, context.activity, context.units);
  const clock = CLOCKS.includes(setting.stat);
  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-caption`}>Caption</label>
        <input
          id={`${id}-caption`}
          className="input"
          type="text"
          value={setting.caption ?? ''}
          placeholder={app.ok ? app.caption : undefined}
          onChange={(event) => set({ caption: sanitizeLabel(event.target.value).split('\n')[0] || undefined })}
        />
      </div>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-decimals`}>Decimal places</label>
        <select
          id={`${id}-decimals`}
          className="select"
          value={setting.decimals ?? ''}
          disabled={clock}
          aria-describedby={clock ? `${id}-decimals-hint` : undefined}
          onChange={(event) => set({ decimals: event.target.value === '' ? undefined : (Number(event.target.value) as 0 | 1 | 2) })}
        >
          <option value="">App default</option>
          <option value="0">0</option>
          <option value="1">1</option>
          <option value="2">2</option>
        </select>
        {clock && (
          <p id={`${id}-decimals-hint`} className="overlay-controls__hint">
            Times and paces are clocks, written the same whatever the places.
          </p>
        )}
      </div>
      <OwnValueField id={id} label="Write my own value" component={component} context={context} own={setting.ownValue} setOwn={(ownValue) => set({ ownValue })} />
    </>
  );
}

export function DateFields({
  id,
  component,
  context,
  onChange,
}: {
  id: string;
  component: OverlayComponent;
  context: StillImageContext;
  onChange: Change;
}) {
  const setting = component.date;
  if (!setting) return null;
  const set = (patch: Partial<typeof setting>) => onChange((c) => ({ ...c, date: { ...(c.date ?? setting), ...patch } }));
  const locale = setting.locale ?? 'en';
  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-language`}>Language</label>
        <select id={`${id}-language`} className="select" value={locale} onChange={(event) => set({ locale: event.target.value })}>
          {languageChoices(locale).map((choice) => (
            <option key={choice.tag} value={choice.tag}>
              {choice.name}
            </option>
          ))}
        </select>
      </div>
      <OwnValueField id={id} label="Write my own text" component={component} context={context} own={setting.ownValue} setOwn={(ownValue) => set({ ownValue })} />
    </>
  );
}

/** The names of the figures and dates whose words the reader wrote, for the note above the elements. */
export function writtenByHand(components: readonly OverlayComponent[]): string | undefined {
  const names = components
    .filter((component) => component.summary?.ownValue !== undefined || component.date?.ownValue !== undefined)
    .map((component) => (component.type === 'date' ? 'Date' : STAT_NAMES[component.summary!.stat]));
  return names.length > 0 ? `Written by hand: ${names.join(', ')}. These do not follow the activity.` : undefined;
}

const STAT_NAMES = { speed: 'Speed', pace: 'Pace', distance: 'Distance', elapsed: 'Elapsed time', moving: 'Moving time', climb: 'Elevation gain' } as const;
