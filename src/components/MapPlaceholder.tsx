export type MapPlaceholderReason = 'no-route' | 'loading';

const MESSAGES: Record<MapPlaceholderReason, { title: string; body: string }> = {
  loading: {
    title: 'Loading map…',
    body: 'Fetching the map component. It is only downloaded once there is a route to draw.',
  },
  'no-route': {
    title: 'No route to display',
    body: 'This activity has no GPS coordinates, so there is nothing to draw on a map. Its stats and charts are still available.',
  },
};

/**
 * Stands in for the map so MapLibre is never constructed without a route to
 * show. Creating the map eagerly would fetch basemap tiles — and reveal that
 * someone is using the app — before any activity is even opened.
 */
export function MapPlaceholder({ reason }: { reason: MapPlaceholderReason }) {
  const { title, body } = MESSAGES[reason];
  return (
    <div
      className="map map--placeholder"
      data-testid="map-placeholder"
      data-reason={reason}
      role="status"
    >
      <div className="map__placeholder-inner">
        <h2 className="map__placeholder-title">{title}</h2>
        <p className="map__placeholder-body">{body}</p>
      </div>
    </div>
  );
}
