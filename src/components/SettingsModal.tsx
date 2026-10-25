import { removeStaleArchives } from '../overlay/export/archiveSink';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { THEME_MODES, THEME_MODE_LABELS, type ThemeMode } from '../domain/theme';
import type { UnitSystem } from '../domain/units';
import { useInteractionStore } from '../state/interactionStore';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SettingsModalProps {
  onClose: () => void;
}

/**
 * AV-007. Settings as a modal rather than a route: opening it leaves the URL
 * and the mounted viewer alone, so the loaded activity, focused range and every
 * session preference survive.
 *
 * Hand-rolled rather than using `<dialog>`, so the focus and keyboard behaviour
 * is explicit and testable in jsdom.
 */
export function SettingsModal({ onClose }: SettingsModalProps) {
  const [cleanup, setCleanup] = useState<string>();
  const [cleaning, setCleaning] = useState(false);
  const titleId = useId();
  /** Where the press that may become a backdrop click started. */
  const pressOriginRef = useRef<EventTarget | null>(null);
  const unitsId = useId();
  const basemapId = useId();
  const themeId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  const unitSystem = useInteractionStore((state) => state.unitSystem);
  const setUnitSystem = useInteractionStore((state) => state.setUnitSystem);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);
  const setBasemapEnabled = useInteractionStore((state) => state.setBasemapEnabled);
  const themeMode = useInteractionStore((state) => state.themeMode);
  const setThemeMode = useInteractionStore((state) => state.setThemeMode);

  // Move focus in on open and hand it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();

    return () => opener?.focus?.();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap: cycle within the dialog rather than escaping to the page.
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className="modal"
      // Dismiss only when a press both starts and ends on the backdrop. Closing
      // on mousedown alone would swallow a drag that began inside the dialog —
      // selecting help text and releasing outside it, say.
      onMouseDown={(event) => {
        pressOriginRef.current = event.target;
      }}
      onClick={(event) => {
        const startedOnBackdrop = pressOriginRef.current === event.currentTarget;
        pressOriginRef.current = null;
        if (startedOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="modal__header">
          <h2 className="modal__title" id={titleId}>
            Settings
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close settings">
            &times;
          </button>
        </header>

        <p className="modal__intro">
          Your theme and basemap choice are remembered on this device. Other settings apply to
          this session. Opened activities stay in memory; generated exports may use temporary local storage.
        </p>

        {/*
          AV-009: a radio group, not three toggles — the modes are mutually
          exclusive, and native radios give that semantics and arrow-key
          navigation without reimplementing either.
        */}
        <fieldset className="setting setting--group">
          <legend className="setting__label">Theme</legend>
          <div className="choice-row">
            {THEME_MODES.map((mode) => (
              <label className="choice" key={mode} htmlFor={`${themeId}-${mode}`}>
                <input
                  id={`${themeId}-${mode}`}
                  type="radio"
                  name={themeId}
                  value={mode}
                  checked={themeMode === mode}
                  onChange={() => setThemeMode(mode as ThemeMode)}
                />
                {THEME_MODE_LABELS[mode]}
              </label>
            ))}
          </div>
          <p className="setting__help">
            System follows your device setting, and keeps following it if you change it.
          </p>
        </fieldset>

        <section className="setting">
          <label className="setting__label" htmlFor={unitsId}>
            Units
          </label>
          <select
            id={unitsId}
            className="select"
            value={unitSystem}
            onChange={(event) => setUnitSystem(event.target.value as UnitSystem)}
          >
            <option value="metric">Metric (km, m)</option>
            <option value="imperial">Imperial (mi, ft)</option>
          </select>
          <p className="setting__help">
            Applies to distance, elevation, pace and speed across the summary and the charts.
          </p>
        </section>

        <section className="setting">
          <label className="setting__label" htmlFor={basemapId}>
            <input
              id={basemapId}
              type="checkbox"
              checked={basemapEnabled}
              onChange={(event) => setBasemapEnabled(event.target.checked)}
            />
            Basemap tiles
          </label>
          <p className="setting__help">
            With the basemap on, the map requests tiles from the tile provider, which reveals the
            approximate area you are viewing. Turn it off to draw the route on a plain background
            and make no external request at all. This choice is remembered when browser storage is
            available. Your activity file is never uploaded either way.
          </p>
        </section>
        <section className="setting">
          <h3 className="setting__label">Temporary exports</h3>
          <p className="setting__help">
            Video renders and image sequences may be written to browser storage on this device.
            Abandoned exports are removed on your next visit where supported. Downloads still
            offered in an open tab are kept; use Discard export beside a download to delete it.
          </p>
          <button type="button" className="button" disabled={cleaning} onClick={async () => {
            setCleaning(true);
            try {
              if (!navigator.locks || !navigator.storage?.getDirectory) {
                setCleanup('This browser cannot safely clean abandoned exports. You can clear this site’s data in your browser settings.');
                return;
              }
              const count = await removeStaleArchives();
              setCleanup(`Removed ${count} abandoned export${count === 1 ? '' : 's'}. Exports in open tabs are kept.`);
            } finally {
              setCleaning(false);
            }
          }}>
            Delete abandoned exports
          </button>
          {cleanup && <p className="setting__help" role="status">{cleanup}</p>}
        </section>
      </div>
    </div>
  );
}
