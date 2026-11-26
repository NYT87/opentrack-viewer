import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { keepFont, keepsFonts, listKeptFonts, removeKeptFont, setKeepsFonts, subscribeKept, type KeptFont } from '../overlay/fontStore';
import {
  BUNDLED_FONTS,
  BUNDLED_LICENCE,
  FONT_FILE_KINDS_TEXT,
  bundledLicenceUrl,
  ensureFamily,
  fontsVersion,
  loadFontFile,
  loadedFamilies,
  subscribeFonts,
} from '../overlay/fonts';
import type { FontProblem } from './useTemplateFonts';

const LOAD = '\u0000load';
const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';

/** Loads a file of the reader's, keeps it if they asked, and says in `onProblem` why it could not be. Resolves with the family. */
async function takeFontFile(file: File, as: string | undefined, say: (message: string) => void): Promise<string | undefined> {
  const read = await loadFontFile(file, as);
  if (!read.ok) {
    say(read.reason);
    return undefined;
  }
  if (keepsFonts()) {
    const kept = await keepFont(read.family, read.bytes);
    if (!kept.ok) say(`${read.family} is loaded for this visit only. ${kept.reason}`);
  }
  return read.family;
}

interface FontFieldProps {
  label: string;
  /** The family, or `undefined` for the layout's font (a component) or the system font (the layout). */
  value: string | undefined;
  /** A component's field: its first choice is the layout's font. */
  inherit?: boolean;
  /** The layout's field: the licences, the switch to keep fonts, and the fonts kept. */
  manage?: boolean;
  onChange: (family: string | undefined) => void;
}

/**
 * AV-1031 (TD-103). The font of a layout or of one component: the system font, the four bundled
 * fonts, the ones the reader has loaded, and a file to load. A font is made ready (fetched from this
 * app, or read from the file) before it is chosen, so a box that grows to fit measures it.
 */
export function FontField({ label, value, inherit = false, manage = false, onChange }: FontFieldProps) {
  const id = useId();
  useSyncExternalStore(subscribeFonts, fontsVersion);
  const fileInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState('');
  const [kept, setKept] = useState<KeptFont[]>([]);
  const [keeping, setKeeping] = useState(keepsFonts());
  useEffect(() => {
    let current = true;
    const read = () =>
      void listKeptFonts().then(
        (rows) => current && setKept(rows),
        () => undefined,
      );
    read();
    // Any field that keeps or removes a font updates every list.
    const stop = subscribeKept(read);
    return () => {
      current = false;
      stop();
    };
  }, []);
  // The newest pick wins, and the newest onChange (a component's closes over the layout as it is now) is the one called.
  const pick = useRef(0);
  const latestChange = useRef(onChange);
  useEffect(() => {
    latestChange.current = onChange;
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loaded = loadedFamilies().filter((family) => !BUNDLED_FONTS.some((font) => font.family === family));
  const keptOnly = kept.map((entry) => entry.family).filter((family) => !loaded.includes(family));
  const readers = [...loaded, ...keptOnly];
  const known = new Set([...BUNDLED_FONTS.map((font) => font.family), ...readers]);

  const choose = async (next: string) => {
    setProblem('');
    const mine = ++pick.current;
    if (next === LOAD) {
      fileInput.current?.click();
      return;
    }
    if (next === '') {
      onChange(undefined);
      return;
    }
    const ready = await ensureFamily(next);
    if (mine !== pick.current || !mounted.current) return;
    if (!ready.ok) {
      setProblem(ready.reason);
      return;
    }
    latestChange.current(next);
  };

  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value ?? ''} onChange={(event) => void choose(event.target.value)}>
        <option value="">{inherit ? 'Layout’s font' : 'System font'}</option>
        <optgroup label="Bundled">
          {BUNDLED_FONTS.map((font) => (
            <option key={font.family} value={font.family}>
              {font.family}
            </option>
          ))}
        </optgroup>
        {(readers.length > 0 || (value !== undefined && !known.has(value))) && (
          <optgroup label="Your fonts">
            {readers.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
            {value !== undefined && !known.has(value) && <option value={value}>{value} (not loaded)</option>}
          </optgroup>
        )}
        <option value={LOAD}>Load a font file…</option>
      </select>
      <input
        ref={fileInput}
        type="file"
        accept={FONT_ACCEPT}
        hidden
        aria-label={`${label}: font file`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setProblem('');
          const mine = ++pick.current;
          void takeFontFile(file, undefined, setProblem).then((family) => {
            if (family && mounted.current && mine === pick.current) latestChange.current(family);
          });
        }}
      />
      <p className="overlay-controls__hint" aria-live="assertive">
        {problem}
      </p>
      {manage && (
        <details className="overlay-controls__details">
          <summary>Fonts: licences and keeping</summary>
          <p className="overlay-controls__hint">
            A font file is read on this device, never sent anywhere. A layout saves the font’s name, not the file, so it
            needs the font on the computer that opens it. Accepted: {FONT_FILE_KINDS_TEXT}, at most 10 MB.
          </p>
          <label className="overlay-controls__choice">
            <input
              type="checkbox"
              checked={keeping}
              onChange={(event) => {
                setKeepsFonts(event.target.checked);
                setKeeping(event.target.checked);
              }}
            />
            <span>Keep loaded fonts in this browser</span>
          </label>
          <p className="overlay-controls__hint">
            Off by default. When on, a font you load next is kept in this browser only (at most 50 MB in all) and nothing
            is sent anywhere. Turning it off does not delete fonts already kept: each has its own Remove.
          </p>
          {kept.length > 0 && (
            <ul aria-label="Fonts kept in this browser">
              {kept.map((entry) => (
                <li key={entry.family}>
                  {entry.family} ({Math.max(1, Math.round(entry.size / 1024))} KB){' '}
                  <button
                    type="button"
                    className="button"
                    aria-label={`Remove ${entry.family}`}
                    onClick={() => void removeKeptFont(entry.family).catch((error: unknown) => setProblem(`${entry.family} was not removed (${error instanceof Error ? error.message : 'the browser refused'}).`))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="overlay-controls__hint">Font licences</p>
          <ul aria-label="Font licences">
            {BUNDLED_FONTS.map((font) => (
              <li key={font.family}>
                {font.family}: {BUNDLED_LICENCE}, {font.copyright}.{' '}
                <a href={bundledLicenceUrl(font)} target="_blank" rel="noreferrer">
                  Licence
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A layout names fonts nothing here has: said once each, with a way to load the file. */
export function MissingFonts({ problems }: { problems: FontProblem[] }) {
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const asking = useRef<string>('');
  if (problems.length === 0 && message === '') return null;
  return (
    <div className="overlay-controls__field" role="group" aria-label="Fonts this layout needs">
      {problems.map((problem) => (
        <p key={problem.family} className="overlay-controls__hint" role="status">
          {problem.reason} It is drawn in the system font.{' '}
          {problem.missing && (
            <button
              type="button"
              className="button"
              onClick={() => {
                asking.current = problem.family;
                input.current?.click();
              }}
            >
              Load {problem.family}…
            </button>
          )}
        </p>
      ))}
      <input
        ref={input}
        type="file"
        accept={FONT_ACCEPT}
        hidden
        aria-label="Font file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setMessage('');
          void takeFontFile(file, asking.current, setMessage);
        }}
      />
      <p className="overlay-controls__hint" aria-live="assertive">
        {message}
      </p>
    </div>
  );
}
