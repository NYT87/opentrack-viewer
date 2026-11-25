import { Link } from 'react-router-dom';
import { ROUTES } from './routes';

interface FormatSupport {
  name: string;
  status: 'Supported' | 'Planned';
  detail: string;
}

const FORMATS: FormatSupport[] = [
  { name: 'GPX', status: 'Supported', detail: 'Tracks and planned routes, with elevation and sensor extensions.' },
  { name: 'FIT', status: 'Supported', detail: 'Garmin and Wahoo recordings, including non-GPS indoor activities.' },
  { name: 'TCX', status: 'Supported', detail: 'Training Center files, with their laps and calories.' },
  { name: 'GoPro video', status: 'Supported', detail: 'GPS and sensor telemetry read from MP4/MOV files, on the video telemetry page.' },
];

/**
 * AV-006. Describes the project and its privacy model, and points at the
 * viewer. It deliberately owns no activity state: loading and inspecting a file
 * belongs to the viewer page.
 */
export function HomePage() {
  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Open your activity files, privately</h2>
          <p className="page__intro">
            OpenTrack Viewer opens GPX, FIT and TCX activity files in your browser and shows the route, the
            numbers and the charts behind a workout — without the file ever leaving your device.
          </p>
          <p>
            <Link className="button button--primary" to={ROUTES.viewer}>
              Open an activity
            </Link>
          </p>
        </header>

        <section className="prose">
          <h3 className="prose__title">Your file stays on your device</h3>
          <p>
            There is no backend, no account and no upload. Parsing, distance and elevation
            calculations, and every chart are computed in this browser tab, and nothing is written
            to disk. Close the tab and the activity is gone.
          </p>
          <p>
            The map is the only part that reaches the network: with the basemap enabled it requests
            tiles from a tile provider, which reveals the approximate area you are looking at. You
            can turn the basemap off in Settings and draw the route on a plain background instead,
            which makes no external request at all.
          </p>
          <p>
            <Link className="link" to={ROUTES.terms}>
              Read the Terms and Conditions
            </Link>
          </p>
        </section>

        <section className="prose" aria-label="Video telemetry">
          <h3 className="prose__title">Telemetry from GoPro videos</h3>
          <p>
            GoPro cameras record their GPS track and sensor data inside the video. Open a local
            MP4 or MOV on the video telemetry page to read it out and view it as an activity. The
            video and everything extracted from it stay in your browser and are never uploaded.
            Videos are not opened in the file viewer; they have a page of their own.
          </p>
          <p>
            <Link className="link" to={ROUTES.videoTelemetry}>
              Open the video telemetry page
            </Link>
          </p>
        </section>

        <section className="prose" aria-label="More tools">
          <h3 className="prose__title">Plan routes and make overlays</h3>
          <p>
            <Link className="link" to={ROUTES.routeBuilder}>
              Route Builder
            </Link>{' '}
            lets you edit a copy of a route, or draw a new one, and save it as a GPX file for a
            watch or bike computer.{' '}
            <Link className="link" to={ROUTES.overlays}>
              Overlays
            </Link>{' '}
            draws a route as a transparent image to lay over a video. Both work in this tab, and
            nothing is uploaded.
          </p>
        </section>

        <section className="prose">
          <h3 className="prose__title">Formats</h3>
          <ul className="format-list">
            {FORMATS.map((format) => (
              <li key={format.name} className="format">
                <span className="format__name">{format.name}</span>
                <span
                  className={
                    format.status === 'Supported'
                      ? 'format__status is-supported'
                      : 'format__status'
                  }
                >
                  {format.status}
                </span>
                <span className="format__detail">{format.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
