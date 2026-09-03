/** AV-003. Shown before any file is loaded. Wording must not imply upload. */
export function EmptyState() {
  return (
    <div className="empty-state">
      <h2 className="empty-state__title">No activity open</h2>
      <p className="empty-state__body">
        Choose a GPX file to see its route, distance, duration and elevation. Parsing happens
        entirely in this browser tab — your activity file is never sent to a server.
      </p>
      <p className="empty-state__note">
        No map is loaded until you open an activity, so nothing is requested from a tile provider
        before then. You can also turn the basemap off to draw the route on a plain background.
      </p>
    </div>
  );
}
