import { useRef, useState } from 'react';
import { FileDropZone } from '../components/FileDropZone';
import { ErrorPanel, WarningList } from '../components/ErrorPanel';
import { ActivityError, toActivityError } from '../domain/errors';
import { formatDistance, formatDuration } from '../domain/units';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useInteractionStore } from '../state/interactionStore';
import {
  mapVideoRefusal,
  useMapVideoStore,
  type MapVideoActivityOrigin,
  type MapVideoBasemap,
} from '../state/mapVideoStore';

/** What became of the last file chosen. */
type SlotState =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'error'; error: ActivityError; fileName: string };

const IDLE: SlotState = { status: 'idle' };

const ORIGIN_LABEL: Record<MapVideoActivityOrigin, string | undefined> = {
  hand: undefined,
  viewer: 'From the file viewer',
  routeBuilder: 'From Route Builder',
  videoTelemetry: 'From the video telemetry page',
};

/**
 * AV-1202. Where map videos are made: a page of its own, reached from Tools or
 * handed an activity by the viewer, Route Builder or the video telemetry page.
 *
 * It opens on its file slot. Nothing on it fetches anything until there is an
 * activity, and before any map is drawn it says what an online basemap
 * tells its tile server, and offers the route alone (TD-064). The preview,
 * the styles and the export are AV-1204 onward.
 */
export function MapVideoPage() {
  const activity = useMapVideoStore((state) => state.activity);
  const origin = useMapVideoStore((state) => state.origin);
  const setActivity = useMapVideoStore((state) => state.setActivity);
  const clear = useMapVideoStore((state) => state.clear);
  const chosenBasemap = useMapVideoStore((state) => state.basemap);
  const setBasemap = useMapVideoStore((state) => state.setBasemap);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);
  const unitSystem = useInteractionStore((state) => state.unitSystem);
  // Until chosen here, the app's own setting decides: tiles off there means route only here.
  const basemap: MapVideoBasemap = chosenBasemap ?? (basemapEnabled ? 'online' : 'route-only');

  const [slot, setSlot] = useState<SlotState>(IDLE);
  const slotRef = useRef<HTMLElement>(null);
  const replace = useRef<HTMLInputElement>(null);
  /** A read finishing after a newer one, or after Remove, writes nothing. */
  const generation = useRef(0);

  const focusSlot = () =>
    setTimeout(() => {
      const element = slotRef.current;
      (
        element?.querySelector<HTMLElement>('.panel--error button') ??
        element?.querySelector<HTMLElement>('.dropzone__target') ??
        element?.querySelector<HTMLElement>('h3')
      )?.focus();
    }, 0);

  const handleFile = async (file: File) => {
    const read = ++generation.current;
    setSlot({ status: 'reading', fileName: file.name });
    try {
      // The viewer's intake: the format detector and the parser registry.
      const { activity: parsed } = await parseActivityFile(file);
      if (read !== generation.current) return;
      const refusal = mapVideoRefusal(parsed);
      if (refusal) throw refusal;
      // Set only once read and accepted, so the activity being replaced stays until then.
      setActivity(parsed, 'hand');
      setSlot(IDLE);
    } catch (error) {
      if (read !== generation.current) return;
      setSlot({ status: 'error', error: toActivityError(error, 'unsupported_format'), fileName: file.name });
      focusSlot();
    }
  };

  const busy = slot.status === 'reading';

  return (
    <main className="page page--map-video">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Map video</h2>
          <p className="page__intro">
            Turn an activity into a short video of the route drawing itself over a map, for sharing.
            The video is made on this device, and the activity and the video are never uploaded.
          </p>
        </header>

        <div className="overlay-column">
          <div className="overlay-workspace__side">
            <section className="prose overlay-slot" aria-label="Activity" ref={slotRef}>
              <h3 className="prose__title" tabIndex={-1}>
                Activity
              </h3>
              {busy && <p role="status">Reading {slot.fileName} in this tab…</p>}
              {slot.status === 'error' && (
                <ErrorPanel
                  error={slot.error}
                  fileName={slot.fileName}
                  onDismiss={() => {
                    setSlot(IDLE);
                    focusSlot();
                  }}
                />
              )}
              {activity ? (
                <>
                  <dl className="summary__grid">
                    <div className="summary__stat">
                      <dt className="summary__label">From</dt>
                      <dd className="summary__value">
                        {activity.source.fileName ?? activity.metadata.name ?? activity.source.format.toUpperCase()}
                      </dd>
                    </div>
                    <div className="summary__stat">
                      <dt className="summary__label">Distance</dt>
                      <dd className="summary__value">{formatDistance(activity.derived?.distanceMeters, unitSystem)}</dd>
                    </div>
                    <div className="summary__stat">
                      <dt className="summary__label">Duration</dt>
                      <dd className="summary__value">{formatDuration(activity.derived?.durationSeconds)}</dd>
                    </div>
                  </dl>
                  {origin && ORIGIN_LABEL[origin] && <p className="overlay-slot__note">{ORIGIN_LABEL[origin]}.</p>}
                  <WarningList warnings={activity.warnings} />
                  <p className="overlay-slot__actions">
                    <button type="button" className="button" onClick={() => replace.current?.click()} disabled={busy}>
                      Choose another activity
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        generation.current += 1;
                        setSlot(IDLE);
                        clear();
                        focusSlot();
                      }}
                    >
                      Remove
                    </button>
                  </p>
                  <input
                    ref={replace}
                    type="file"
                    hidden
                    accept={SUPPORTED_FORMATS.map((extension) => `.${extension}`).join(',')}
                    data-testid="map-video-activity-input"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void handleFile(file);
                    }}
                  />
                </>
              ) : (
                !busy && (
                  <FileDropZone
                    acceptedExtensions={SUPPORTED_FORMATS}
                    onFile={(file) => void handleFile(file)}
                    testId="map-video-activity-input"
                  />
                )
              )}
            </section>

            {/* Said before any map exists, so no tile is fetched before the reader has read this (TD-064). */}
            {activity && (
              <fieldset className="prose map-video-basemap">
                <legend className="prose__title">Map</legend>
                <label className="overlay-controls__choice">
                  <input
                    type="radio"
                    name="map-video-basemap"
                    checked={basemap === 'online'}
                    onChange={() => setBasemap('online')}
                  />
                  <span>
                    Online map. Its tiles come from OpenFreeMap, whose server learns which area the video
                    shows, as any online map does. The route itself is never sent.
                  </span>
                </label>
                <label className="overlay-controls__choice">
                  <input
                    type="radio"
                    name="map-video-basemap"
                    checked={basemap === 'route-only'}
                    onChange={() => setBasemap('route-only')}
                  />
                  <span>Route only. The route is drawn on a plain background, and nothing is fetched.</span>
                </label>
              </fieldset>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
