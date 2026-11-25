import { useOutletContext } from 'react-router-dom';
import type { ShellContext } from '../app/AppShell';

/** AV-003. Shown before any file is loaded. Wording must not imply upload. */
export function EmptyState() {
  // Present inside the app shell; absent when the component renders alone.
  const shell = useOutletContext<ShellContext | undefined>();
  return (
    <div className="empty-state">
      <h2 className="empty-state__title">No activity open</h2>
      <p className="empty-state__body">
        Choose a GPX, FIT, TCX or KML file to see its route, distance, duration and elevation. Parsing happens
        entirely in this browser tab — your activity file is never sent to a server.
      </p>
      <p className="empty-state__note">
        No map is loaded until you open an activity, so nothing is requested from a tile provider
        before then. You can also turn the basemap off in{' '}
        {shell ? (
          <button type="button" className="link link--button" onClick={shell.openSettings}>
            Settings
          </button>
        ) : (
          'Settings'
        )}{' '}
        to draw the route on a plain background.
      </p>
    </div>
  );
}
