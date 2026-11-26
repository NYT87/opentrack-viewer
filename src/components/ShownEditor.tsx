import { useId, useState } from 'react';
import { VISIBILITY_FADE_MAX_SECONDS, parseVisibility, type OverlayVisibility } from '../overlay/visibility';
import { formatOffset, parseOffset } from './OverlayPreview';

type Mode = 'always' | 'range' | 'for';
type Field = 'from' | 'to' | 'for' | 'fadeIn' | 'fadeOut';

/** m:ss.s, as the video's own clock reads (the sync field's helper writes under a minute as bare seconds). */
const clock = (seconds: number) => {
  const tenths = Math.round(seconds * 10) / 10;
  return tenths < 60 ? `0:${tenths < 10 ? '0' : ''}${tenths}` : formatOffset(tenths);
};
const clean = (seconds: number) => Math.round(seconds * 1000) / 1000;
const modeOf = (visibility: OverlayVisibility | undefined): Mode => (visibility ? 'range' : 'always');

/** AV-1029 (TD-101). The part of the video a component is shown for, in the video's own seconds. */
export function windowText(visibility: OverlayVisibility | undefined): string {
  if (!visibility) return 'Shown for the whole video.';
  const { from, to, fadeIn, fadeOut } = visibility;
  const parts = [`Shown from ${clock(from ?? 0)} ${to === undefined ? 'to the end' : `to ${clock(to)}`}`];
  if (fadeIn) parts.push(`fading in over ${fadeIn} s`);
  if (fadeOut) parts.push(`fading out over ${fadeOut} s`);
  return `${parts.join(', ')}.`;
}

/**
 * AV-1029 (TD-101). *Shown*: always, from a time to a time, or for some seconds from a time, with
 * fades. "For N seconds" is only how `to` is typed: what is saved is `from` and `to = from + N`.
 * What is typed stays as typed, with the reason, until it reads as a time.
 */
export function ShownEditor({
  visibility,
  playhead,
  onChange,
}: {
  visibility: OverlayVisibility | undefined;
  /** The canvas's moment now, in the video's seconds. */
  playhead: () => number;
  onChange: (visibility: OverlayVisibility | undefined) => void;
}) {
  const id = useId();
  const [picked, setMode] = useState<Mode>(modeOf(visibility));
  // A window that comes back (Undo) is never shown under Always.
  const mode = visibility && picked === 'always' ? 'range' : picked;
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});
  // A field's problem is said once it is left or Enter is pressed, not while it is being typed ("1:" on the way to 1:30).
  const [tried, setTried] = useState<Partial<Record<Field, true>>>({});
  // A playhead the window cannot take, said in words: its time rounded to tenths may read as one the field would accept.
  const [refusals, setRefusals] = useState<Partial<Record<Field, string>>>({});
  const from = visibility?.from ?? 0;
  const to = visibility?.to;
  const length = to === undefined ? undefined : clean(to - from);

  const draft = (field: Field, text: string | undefined) => {
    setDrafts((current) => ({ ...current, [field]: text }));
    setTried((current) => ({ ...current, [field]: undefined }));
    setRefusals((current) => ({ ...current, [field]: undefined }));
  };
  const write = (patch: Partial<Record<keyof OverlayVisibility, number | undefined>>) => {
    const raw: Record<string, unknown> = { ...visibility, ...patch };
    for (const key of Object.keys(raw)) if (raw[key] === undefined) delete raw[key];
    const next = parseVisibility(raw);
    if (JSON.stringify(next) !== JSON.stringify(visibility)) onChange(next);
  };
  const problem = (field: Field, text: string): string | undefined => {
    if (text.trim() === '') return undefined;
    const seconds = parseOffset(text);
    if (seconds === undefined || seconds < 0) return `"${text}" is not a time. Use minutes and seconds, or seconds: 1:30 or 90.`;
    if (field === 'from' && mode === 'range' && to !== undefined && seconds >= to) return `"${text}" is not before the end, ${clock(to)}.`;
    if (field === 'to' && seconds <= from) return `"${text}" is not after the start, ${clock(from)}.`;
    if (field === 'for' && seconds <= 0) return 'A window is longer than 0 seconds.';
    return undefined;
  };
  const problems: Partial<Record<Field, string>> = Object.fromEntries((['from', 'to', 'for', 'fadeIn', 'fadeOut'] as Field[]).flatMap((field) => {
    const text = drafts[field];
    const message = refusals[field] ?? (text === undefined || !tried[field] ? undefined : problem(field, text));
    return message ? [[field, message]] : [];
  }));

  const pick = (next: Mode) => {
    setMode(next);
    setDrafts({});
    setTried({});
    setRefusals({});
    if (next === 'always') onChange(undefined);
    else if (next === 'for') write({ to: clean(from + (length ?? 5)) });
  };
  // One change is one Undo step: a field is applied when it is left or Enter is pressed, and only if it says something new.
  const edit = (field: Field, text: string) => {
    draft(field, text);
  };
  const commit = (field: Field) => {
    const text = drafts[field];
    if (text === undefined) return;
    if (problem(field, text)) return;
    draft(field, undefined);
    const seconds = text.trim() === '' ? undefined : parseOffset(text);
    if (field === 'from') write({ from: seconds, ...(mode === 'for' ? { to: clean((seconds ?? 0) + (length ?? 5)) } : {}) });
    else if (field === 'to') write({ to: seconds });
    else if (field === 'for') write({ to: seconds === undefined ? undefined : clean(from + seconds) });
    else write({ [field]: seconds });
  };
  const leave = (field: Field) => {
    setTried((current) => ({ ...current, [field]: true }));
    commit(field);
  };
  const setToPlayhead = (field: 'from' | 'to') => {
    const now = clean(playhead());
    draft(field, undefined);
    const refuse = (message: string) => setRefusals((current) => ({ ...current, [field]: message }));
    if (field === 'from' && mode !== 'for' && to !== undefined && now >= to) refuse(`The playhead, ${clock(now)}, is not before the end, ${clock(to)}.`);
    else if (field === 'from') write({ from: now, ...(mode === 'for' ? { to: clean(now + (length ?? 5)) } : {}) });
    else if (now > from) write({ to: now });
    else refuse(`The playhead, ${clock(now)}, is not after the start, ${clock(from)}.`);
  };

  const commitFade = (field: 'fadeIn' | 'fadeOut') => {
    const text = drafts[field];
    draft(field, undefined);
    const seconds = Number(text);
    if (text !== undefined && text.trim() !== '' && Number.isFinite(seconds) && clean(seconds) !== (visibility?.[field] ?? 0)) write({ [field]: seconds });
  };

  const timeField = (field: Field, label: string, value: string, playheadButton?: 'from' | 'to') => (
    <div className="overlay-controls__field">
      <label htmlFor={`${id}-${field}`}>{label}</label>
      <input
        id={`${id}-${field}`}
        className="input"
        type="text"
        inputMode="decimal"
        aria-invalid={problems[field] ? true : undefined}
        aria-describedby={problems[field] ? `${id}-${field}-hint` : undefined}
        value={drafts[field] ?? value}
        onChange={(event) => edit(field, event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && leave(field)}
        onBlur={() => leave(field)}
      />
      {playheadButton && (
        <button type="button" className="button" aria-label={`Set to the playhead, ${label.toLowerCase()}`} onClick={() => setToPlayhead(playheadButton)}>
          Set to the playhead
        </button>
      )}
      {problems[field] && (
        <p id={`${id}-${field}-hint`} className="overlay-controls__hint is-invalid" role="alert">
          {problems[field]}
        </p>
      )}
    </div>
  );
  const fadeField = (field: 'fadeIn' | 'fadeOut', label: string) => (
    <div className="overlay-controls__field">
      <label htmlFor={`${id}-${field}`}>{label}</label>
      <input
        id={`${id}-${field}`}
        className="input"
        type="number"
        inputMode="decimal"
        min={0}
        max={VISIBILITY_FADE_MAX_SECONDS}
        step={0.5}
        value={drafts[field] ?? String(visibility?.[field] ?? 0)}
        onChange={(event) => draft(field, event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && commitFade(field)}
        onBlur={() => commitFade(field)}
      />
    </div>
  );

  return (
    <fieldset className="overlay-controls__group" aria-label="Shown">
      <legend>Shown</legend>
      {([['always', 'Always'], ['range', 'From … to …'], ['for', 'For … seconds from …']] as const).map(([value, label]) => (
        <label key={value} className="overlay-controls__choice">
          <input type="radio" name={`${id}-mode`} checked={mode === value} onChange={() => pick(value)} />
          <span>{label}</span>
        </label>
      ))}
      {mode !== 'always' && (
        <>
          {timeField('from', 'From', clock(from), 'from')}
          {mode === 'range' && timeField('to', 'To', to === undefined ? '' : clock(to), 'to')}
          {mode === 'for' && timeField('for', 'For (s)', length === undefined ? '' : String(length))}
          {fadeField('fadeIn', 'Fade in (s)')}
          {fadeField('fadeOut', 'Fade out (s)')}
        </>
      )}
      <p className="overlay-controls__hint">{windowText(visibility)} Times are in the video, as minutes and seconds.</p>
    </fieldset>
  );
}
