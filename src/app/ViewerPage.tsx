import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartPanel } from '../components/ChartPanel';
import { DeviceInfoPanel } from '../components/DeviceInfoPanel';
import { SensorStreamPanel } from '../components/SensorStreamPanel';
import { resolvePerformanceMetric } from '../domain/performance';
import { EmptyState } from '../components/EmptyState';
import { ErrorPanel, WarningList } from '../components/ErrorPanel';
import { ExportPanel } from '../components/ExportPanel';
import { CustomTrackLink } from '../components/CustomTrackLink';
import { RouteOverlayLink } from '../components/RouteOverlayLink';
import { FileDropZone, describeFormats } from '../components/FileDropZone';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { LapsPanel, hasUsefulLaps } from '../components/LapsPanel';
import { MapPlaceholder } from '../components/MapPlaceholder';
import { ACTIVITY_TITLE_ID, SummaryPanel } from '../components/SummaryPanel';
import { buildSummaryStats } from '../components/summaryStats';
import { hasAnyChart } from '../domain/charts';
import type { Activity } from '../domain/activity';
import type { ActivityError } from '../domain/errors';
import type { PerformanceMetric } from '../domain/performance';
import { MISSING, formatDistance, type UnitSystem } from '../domain/units';
import { ViewerSectionNav, type ViewerSection } from '../components/ViewerSectionNav';
import { sliceActivity } from '../domain/activitySlice';
import { hasDrawableRoute, lapPointRange } from '../domain/range';
import { activityToRouteGeoJSON, pointToGeoJSON } from '../domain/geojson';
import { selectViewerState, useActivityStore } from '../state/activityStore';
import { activePointIndex, useInteractionStore } from '../state/interactionStore';
/**
 * MapLibre is by far the largest dependency, and an activity without a route
 * never needs it. Loading it on demand keeps it out of the initial bundle.
 */
const ActivityMap = lazy(() =>
  import('../components/ActivityMap').then((module) => ({ default: module.ActivityMap })),
);

/**
 * TD-056. What a screen reader hears once a file opens: how far and how long,
 * the two figures a reader checks first. The title is not repeated: focus
 * moves to it, and a focused heading is read out already. A figure the file
 * cannot give is left out rather than read as a dash.
 */
function openedMessage(activity: Activity, units: UnitSystem, metric: PerformanceMetric): string {
  const stats = buildSummaryStats(activity, units, metric);
  const figures = ['distance', 'duration']
    .map((key) => stats.find((stat) => stat.key === key))
    .filter((stat) => stat && stat.value !== MISSING)
    .map((stat) => `${stat!.label.toLowerCase()} ${stat!.value}`);
  return `Activity opened${figures.length ? `: ${figures.join(', ')}` : ''}.`;
}

/**
 * AV-304. The vertical slice wiring: file → parser → domain → adapters → UI.
 * Every step runs in this tab; no request carries activity data.
 */
export function ViewerPage() {
  const status = useActivityStore((state) => state.status);
  const activity = useActivityStore((state) => state.activity);
  const error = useActivityStore((state) => state.error);
  const fileName = useActivityStore((state) => state.fileName);
  const loadFile = useActivityStore((state) => state.loadFile);
  const replaceFile = useActivityStore((state) => state.replaceFile);

  const viewerState = useMemo(
    () => selectViewerState({ status, activity, error, fileName }),
    [status, activity, error, fileName],
  );
  const clear = useActivityStore((state) => state.clear);

  const hoveredPointIndex = useInteractionStore((state) => state.hoveredPointIndex);
  const selectedPointIndex = useInteractionStore((state) => state.selectedPointIndex);
  const setHoveredPoint = useInteractionStore((state) => state.setHoveredPoint);
  const setSelectedPoint = useInteractionStore((state) => state.setSelectedPoint);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);
  const unitSystem = useInteractionStore((state) => state.unitSystem);
  // AV-908. The overview's primary figure follows the same choice as the
  // charts, so the page never shows pace above a speed chart.
  const performanceMetric = useInteractionStore((state) => state.performanceMetric);
  const selectedRange = useInteractionStore((state) => state.selectedRange);
  const selectedLapIndex = useInteractionStore((state) => state.selectedLapIndex);
  const chartXAxisMode = useInteractionStore((state) => state.chartXAxisMode);
  const setChartXAxisMode = useInteractionStore((state) => state.setChartXAxisMode);

  const activeIndex = activePointIndex({ hoveredPointIndex, selectedPointIndex });

  /*
   * TD-056. Opening and closing a file each unmount the control the reader
   * pressed: the drop zone goes when the activity appears, and *Close
   * activity* goes with the activity. Left alone, focus falls to the page body
   * and nothing is said. Focus moves to the activity's title on open and back
   * to the drop zone on close, and both are announced in a polite region that
   * stays mounted across the two layouts, so the change is heard.
   */
  const liveRef = useRef<HTMLParagraphElement>(null);
  const intakeRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef<string | undefined>(undefined);
  const previousActivity = useRef<Activity | undefined>(undefined);
  const metric = activity ? resolvePerformanceMetric(activity, performanceMetric) : undefined;
  useEffect(() => {
    const previous = previousStatus.current;
    const previousOpen = previousActivity.current;
    previousStatus.current = viewerState.status;
    previousActivity.current = viewerState.status === 'ready' ? viewerState.activity : undefined;
    // Arriving on the page is not an event; only a change is. A file dropped
    // on an open activity replaces it without leaving the ready state, so a
    // new activity counts as a change too.
    const replaced =
      viewerState.status === 'ready' && previousOpen !== undefined && previousOpen !== viewerState.activity;
    if (previous === undefined || (previous === viewerState.status && !replaced)) return;
    const announce = (message: string) => {
      if (liveRef.current) liveRef.current.textContent = message;
    };

    if (viewerState.status === 'ready' && metric) {
      document.getElementById(ACTIVITY_TITLE_ID)?.focus();
      announce(openedMessage(viewerState.activity, unitSystem, metric));
    } else if (previous === 'ready' && viewerState.status === 'empty') {
      intakeRef.current?.querySelector<HTMLElement>('.dropzone__target')?.focus();
      announce('Activity closed. Choose a file to open another.');
    }
  }, [viewerState, unitSystem, metric]);
  const liveRegion = <p ref={liveRef} className="visually-hidden" role="status" aria-live="polite" />;

  /*
   * TD-056. A file dropped anywhere on an open activity replaces it, the way
   * the drop zone opened the first one: comparing two files no longer means
   * Close activity and the picker again. A file of a kind the app cannot read
   * is refused and said, and the activity stays.
   */
  const [isDropping, setIsDropping] = useState(false);
  /**
   * What happened to the last file dropped on the open activity, said on the
   * page as well as to a screen reader: being read, refused, or failed (with
   * the activity kept). Cleared when the reader dismisses it.
   */
  const [dropNotice, setDropNotice] = useState<
    | { kind: 'reading'; fileName: string }
    | { kind: 'unsupported'; message: string }
    | { kind: 'failed'; fileName: string; error: ActivityError }
    | undefined
  >();
  const dropGeneration = useRef(0);
  useEffect(() => {
    if (status !== 'ready') dropGeneration.current += 1;
  }, [status]);
  const dropHandlers = {
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setIsDropping(true);
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDropping(false);
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const file = event.dataTransfer.files[0];
      setIsDropping(false);
      if (!file) return;
      event.preventDefault();
      const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
      if (!(SUPPORTED_FORMATS as readonly string[]).includes(extension)) {
        const message = `"${file.name}" is not supported. Choose ${describeFormats(SUPPORTED_FORMATS)}.`;
        setDropNotice({ kind: 'unsupported', message });
        if (liveRef.current) liveRef.current.textContent = `${message} The open activity is unchanged.`;
        return;
      }
      // Parsed aside: the open activity stays until the new one has parsed,
      // and stays for good if it fails.
      const generation = ++dropGeneration.current;
      setDropNotice({ kind: 'reading', fileName: file.name });
      void replaceFile(file).then((error) => {
        if (generation !== dropGeneration.current) return;
        if (!error) {
          setDropNotice(undefined);
          return;
        }
        // The error panel is an alert, and says it; the note under it says
        // the activity was kept.
        setDropNotice({ kind: 'failed', fileName: file.name, error });
      });
    },
  };

  // Memoized so a hover does not rebuild the route on every pointer move (§14).
  const route = useMemo(
    () =>
      activity
        ? activityToRouteGeoJSON(activity)
        : { featureCollection: { type: 'FeatureCollection' as const, features: [] }, sourceIndices: [], isEmpty: true },
    [activity],
  );

  /**
   * AV-604. The route of the focused section, which the map draws over the
   * dimmed full route. Undefined whenever nothing is focused, or when the
   * selection no longer fits this activity.
   */
  const focusRoute = useMemo(() => {
    if (!activity || !selectedRange) return undefined;
    const slice = sliceActivity(activity, selectedRange);
    return slice.ok ? activityToRouteGeoJSON(slice.activity) : undefined;
  }, [activity, selectedRange]);

  /**
   * §17. The route of the highlighted lap, drawn over the full route in its own
   * colour. The map is never fitted to it: picking a lap says which part of the
   * ride it is, not that the reader wants to be taken there.
   */
  const lapRoute = useMemo(() => {
    if (!activity || selectedLapIndex === undefined) return undefined;
    const lap = activity.laps?.find((entry) => entry.index === selectedLapIndex);
    const range = lap ? lapPointRange(activity, lap) : undefined;
    if (!range) return undefined;

    const slice = sliceActivity(activity, range);
    return slice.ok ? activityToRouteGeoJSON(slice.activity) : undefined;
  }, [activity, selectedLapIndex]);

  /**
   * Which laps can actually be picked out on the map. A lap whose points sit
   * either side of a pause has no line to draw, and offering a control that
   * silently does nothing is worse than not offering one.
   */
  const highlightableLaps = useMemo(() => {
    const drawable = new Set<number>();
    if (!activity) return drawable;

    for (const lap of activity.laps ?? []) {
      const range = lapPointRange(activity, lap);
      if (range && hasDrawableRoute(activity, range)) drawable.add(lap.index);
    }
    return drawable;
  }, [activity]);

  const marker = useMemo(() => {
    if (!activity || activeIndex === undefined) return pointToGeoJSON(undefined);
    return pointToGeoJSON(activity.points[activeIndex]);
  }, [activity, activeIndex]);

  // The map resolves the hit route feature to an activity point index itself.
  const handleRouteHover = useCallback(
    (pointIndex: number | undefined) => setHoveredPoint(pointIndex, 'map'),
    [setHoveredPoint],
  );

  const handleChartHover = useCallback(
    (pointIndex: number | undefined) => setHoveredPoint(pointIndex, 'chart'),
    [setHoveredPoint],
  );

  // AV-004: the viewer layout exists only in the ready state. Anything else
  // keeps the user on the upload-focused layout, so a failed parse can never
  // half-reveal a map or an empty summary panel.
  if (viewerState.status !== 'ready') {
    return (
      <main className="viewer viewer--intake">
        {liveRegion}
        <div className="intake" ref={intakeRef}>
          <FileDropZone
            onFile={loadFile}
            disabled={viewerState.status !== 'empty' && viewerState.status !== 'error'}
          />

          {(viewerState.status === 'readingFile' || viewerState.status === 'processingFile') && (
            <p className="status" role="status">
              {viewerState.status === 'readingFile' ? 'Reading' : 'Parsing'}
              {viewerState.fileName ? ` ${viewerState.fileName}` : ''} locally…
            </p>
          )}

          {viewerState.status === 'error' && (
            <ErrorPanel error={viewerState.error} onDismiss={clear} fileName={viewerState.fileName} />
          )}

          {viewerState.status === 'empty' && <EmptyState />}
        </div>
      </main>
    );
  }

  const readyActivity = viewerState.activity;

  // AV-011: only sections that actually render get a link.
  const laps = readyActivity.laps;
  const showLaps = hasUsefulLaps(laps);

  // AV-516: no charts section, and no link to one, when nothing is chartable.
  const showCharts = hasAnyChart(readyActivity, resolvePerformanceMetric(readyActivity, performanceMetric));

  const sections: ViewerSection[] = [
    { id: 'activity-overview', label: 'Overview' },
    ...(route.isEmpty ? [] : [{ id: 'activity-map', label: 'Map' }]),
    ...(showLaps ? [{ id: 'activity-laps', label: 'Laps' }] : []),
    ...(showCharts ? [{ id: 'activity-charts', label: 'Charts' }] : []),
    { id: 'activity-export', label: 'Export' },
  ];

  return (
    <main className={isDropping ? 'viewer is-dropping' : 'viewer'} {...dropHandlers}>
      {liveRegion}
      {isDropping && (
        <div className="viewer__drop" aria-hidden="true">
          Drop to open this file instead. This one stays open if it cannot be read.
        </div>
      )}
      <div className="viewer__content">
        <ViewerSectionNav sections={sections} />

        {/* AV-011: overview box, then map box, then charts — in that order. */}
        <div className="viewer__sections">
          {dropNotice?.kind === 'reading' && (
            <p className="status viewer__notice" role="status">
              Reading {dropNotice.fileName} locally…
            </p>
          )}
          {dropNotice?.kind === 'unsupported' && (
            <div className="panel viewer__notice">
              <p className="panel__message">{dropNotice.message} The open activity is unchanged.</p>
              <button type="button" className="button" onClick={() => setDropNotice(undefined)}>
                Dismiss
              </button>
            </div>
          )}
          {dropNotice?.kind === 'failed' && (
            <div className="viewer__notice">
              <ErrorPanel error={dropNotice.error} fileName={dropNotice.fileName} onDismiss={() => setDropNotice(undefined)} />
              <p className="viewer__notice-kept">The activity you had open is still open below.</p>
            </div>
          )}
          {/* Section targets take focus from the section nav (TD-056), never from Tab. */}
          <section className="box" id="activity-overview" aria-label="Activity overview" tabIndex={-1}>
            <SummaryPanel
              activity={readyActivity}
              units={unitSystem}
              metric={resolvePerformanceMetric(readyActivity, performanceMetric)}
            />
            {/*
              An activity with no coordinates says so once, here, instead of
              holding a map-sized box open to say it (DESIGN: no empty boxes).
            */}
            {route.isEmpty && (
              <p className="summary__note" data-testid="no-route-note">
                This file has no GPS coordinates, so there is no route to draw on a map. Its other
                figures are below.
              </p>
            )}
            <DeviceInfoPanel device={readyActivity.metadata.device} />
            <SensorStreamPanel streams={readyActivity.sensorStreams} />
            <WarningList warnings={readyActivity.warnings} />
          </section>

          {/*
            AV-406: laps sit beside the map on large screens and fall below it
            on narrower ones, which the grid handles without reordering the DOM.
          */}
          {(showLaps || !route.isEmpty) && (
            <div
              className={showLaps && !route.isEmpty ? 'map-section has-laps' : 'map-section'}
              id={route.isEmpty ? undefined : 'activity-map'}
              tabIndex={route.isEmpty ? undefined : -1}
            >
              {showLaps && (
                <div className="box map-section__laps" id="activity-laps" tabIndex={-1}>
                  <LapsPanel laps={laps} units={unitSystem} highlightable={highlightableLaps} />
                </div>
              )}

              {!route.isEmpty && (
                <section className="box box--map map-section__map" aria-label="Route map">
                  <Suspense fallback={<MapPlaceholder reason="loading" />}>
                    <ActivityMap
                      route={route}
                      focusRoute={focusRoute}
                      lapRoute={lapRoute}
                      marker={marker}
                      basemapEnabled={basemapEnabled}
                      onRouteHover={handleRouteHover}
                      onRouteClick={setSelectedPoint}
                      units={unitSystem}
                      description={`Map of the route, ${formatDistance(readyActivity.derived?.distanceMeters, unitSystem)} from the blue start dot to the dark finish dot. The charts below step along it with the arrow keys.`}
                    />
                  </Suspense>
                </section>
              )}
            </div>
          )}

          {showCharts && (
          <section className="box" id="activity-charts" tabIndex={-1}>
            <ChartPanel
              activity={readyActivity}
              xAxisPreference={chartXAxisMode}
              onXAxisChange={setChartXAxisMode}
              units={unitSystem}
              activePointIndex={activeIndex}
              onHoverPoint={handleChartHover}
              onSelectPoint={setSelectedPoint}
              hasRoute={!route.isEmpty}
            />
          </section>
          )}

          <section className="box" id="activity-export" aria-label="Export activity" tabIndex={-1}>
            <ExportPanel activity={readyActivity} selectedRange={selectedRange} />
            {/*
              Both make something of the route, so a file without one gets
              neither, rather than two disabled buttons explaining why (DESIGN:
              nothing renders before the data earns it).
            */}
            {!route.isEmpty && <RouteOverlayLink activity={readyActivity} selectedRange={selectedRange} />}
            {!route.isEmpty && <CustomTrackLink activity={readyActivity} selectedRange={selectedRange} />}
          </section>
        </div>
      </div>
    </main>
  );
}
