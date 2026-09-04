import { Suspense, lazy, useCallback, useMemo } from 'react';
import { ChartPanel } from '../components/ChartPanel';
import { DeviceInfoPanel } from '../components/DeviceInfoPanel';
import { EmptyState } from '../components/EmptyState';
import { ErrorPanel, WarningList } from '../components/ErrorPanel';
import { FileDropZone } from '../components/FileDropZone';
import { LapsPanel, hasUsefulLaps } from '../components/LapsPanel';
import { MapPlaceholder } from '../components/MapPlaceholder';
import { SummaryPanel } from '../components/SummaryPanel';
import { ViewerSectionNav, type ViewerSection } from '../components/ViewerSectionNav';
import { sliceActivity } from '../domain/activitySlice';
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
 * AV-304. The vertical slice wiring: file → parser → domain → adapters → UI.
 * Every step runs in this tab; no request carries activity data.
 */
export function ViewerPage() {
  const status = useActivityStore((state) => state.status);
  const activity = useActivityStore((state) => state.activity);
  const error = useActivityStore((state) => state.error);
  const fileName = useActivityStore((state) => state.fileName);
  const loadFile = useActivityStore((state) => state.loadFile);

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
  const selectedRange = useInteractionStore((state) => state.selectedRange);
  const chartXAxisMode = useInteractionStore((state) => state.chartXAxisMode);
  const setChartXAxisMode = useInteractionStore((state) => state.setChartXAxisMode);

  const activeIndex = activePointIndex({ hoveredPointIndex, selectedPointIndex });

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
        <div className="intake">
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
            <ErrorPanel error={viewerState.error} onDismiss={clear} />
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

  const sections: ViewerSection[] = [
    { id: 'activity-overview', label: 'Overview' },
    ...(route.isEmpty ? [] : [{ id: 'activity-map', label: 'Map' }]),
    ...(showLaps ? [{ id: 'activity-laps', label: 'Laps' }] : []),
    { id: 'activity-charts', label: 'Charts' },
  ];

  return (
    <main className="viewer">
      <div className="viewer__content">
        <ViewerSectionNav sections={sections} />

        {/* AV-011: overview box, then map box, then charts — in that order. */}
        <div className="viewer__sections">
          <section className="box" id="activity-overview" aria-label="Activity overview">
            <SummaryPanel activity={readyActivity} units={unitSystem} />
            <DeviceInfoPanel device={readyActivity.metadata.device} />
            <WarningList warnings={readyActivity.warnings} />
          </section>

          {/*
            AV-406: laps sit beside the map on large screens and fall below it
            on narrower ones, which the grid handles without reordering the DOM.
          */}
          <div className={showLaps ? 'map-section has-laps' : 'map-section'} id="activity-map">
            {showLaps && (
              <div className="box map-section__laps" id="activity-laps">
                <LapsPanel laps={laps} units={unitSystem} />
              </div>
            )}

            <section className="box box--map map-section__map" aria-label="Route map">
              {route.isEmpty ? (
                <MapPlaceholder reason="no-route" />
              ) : (
                <Suspense fallback={<MapPlaceholder reason="loading" />}>
                  <ActivityMap
                    route={route}
                    focusRoute={focusRoute}
                    marker={marker}
                    basemapEnabled={basemapEnabled}
                    onRouteHover={handleRouteHover}
                    onRouteClick={setSelectedPoint}
                  />
                </Suspense>
              )}
            </section>
          </div>

          <section className="box" id="activity-charts">
            <ChartPanel
              activity={readyActivity}
              xAxisPreference={chartXAxisMode}
              onXAxisChange={setChartXAxisMode}
              units={unitSystem}
              activePointIndex={activeIndex}
              onHoverPoint={handleChartHover}
              onSelectPoint={setSelectedPoint}
            />
          </section>
        </div>
      </div>
    </main>
  );
}
