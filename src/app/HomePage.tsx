import { Link, useOutletContext } from 'react-router-dom';
import { GITHUB_URL } from '../components/SiteFooter';
import type { ShellContext } from './AppShell';
import { ROUTES } from './routes';

interface FormatSupport {
  name: string;
  /** Every listed format is read; only some are written. */
  access: 'Read · Write' | 'Read only';
  detail: string;
}

const FORMATS: FormatSupport[] = [
  { name: 'GPX', access: 'Read · Write', detail: 'Tracks and planned routes, with elevation and sensor extensions.' },
  { name: 'FIT', access: 'Read · Write', detail: 'Garmin and Wahoo recordings, including non-GPS indoor activities.' },
  { name: 'TCX', access: 'Read · Write', detail: 'Training Center files, with their laps and calories.' },
  {
    name: 'KML',
    access: 'Read only',
    detail: 'Google Earth routes and timed tracks, read for viewing and conversion to GPX, FIT or TCX. Not written.',
  },
];

/**
 * The four tools, in the order the header's Tools menu lists them. The labels
 * are the menu's own, so a name learnt here is recognised there; the detail
 * says in plain words what each one is for.
 */
const TOOLS = [
  {
    to: ROUTES.viewer,
    label: 'File viewer',
    detail:
      'Open a GPX, FIT, TCX or KML file. See the route on a map, the distance, time and climbs, the laps and the charts, then download it as another format.',
  },
  {
    to: ROUTES.videoTelemetry,
    label: 'Video telemetry',
    detail:
      'GoPro cameras record where they were alongside the picture. Read that track out of a video and view it as an activity.',
  },
  {
    to: ROUTES.overlays,
    label: 'Overlays',
    detail:
      'Bring a GoPro video, an activity file, or both. Draw speed, distance, the route and the climbs over the picture, then export a transparent PNG sequence for your editor or burn it into the video.',
  },
  {
    to: ROUTES.routeBuilder,
    label: 'Route Builder',
    detail:
      'Plan a track from scratch or from a recorded route, point by point, and export a GPX your device can follow.',
  },
] as const;

const PRIVACY_TEST_URL = `${GITHUB_URL}/blob/main/e2e/viewer.spec.ts`;
/** The README's privacy model: the plain-language account of what the tests check. */
const PRIVACY_MODEL_URL = `${GITHUB_URL}#privacy-model`;

/**
 * What the browser tests hold at zero, set as readings rather than prose. The
 * page states the figures the suite enforces; it does not measure them itself.
 * Each line is worded to claim exactly what its test asserts in
 * e2e/viewer.spec.ts and no more: with the basemap on, tiles do leave the page
 * once a file is open, so no line may say that nothing does.
 */
const PROOF = [
  // 'never uploads the activity file': no POST, PUT or PATCH.
  'Uploads while a file is open',
  // Same test: no request body holds a coordinate or the file name.
  'Coordinates or file name in a request',
  // 'requests no map tiles until an activity is opened': nothing off-origin
  // from the file viewer while it is empty. Scoped to the viewer on purpose:
  // Route Builder and Overlays draw a map before any file, and with the basemap
  // on that map fetches tiles.
  'Outside requests from the empty file viewer',
] as const;

/** The arrow that marks a tool row as a destination; drawn, like the footer's mark. */
function ToolArrow() {
  return (
    <svg
      className="tool__arrow"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/**
 * AV-006. Describes the project and its privacy model, and points at the
 * viewer. It deliberately owns no activity state: loading and inspecting a file
 * belongs to the viewer page.
 */
export function HomePage() {
  // Undefined when rendered outside the shell; "Settings" then stays plain text.
  const shell = useOutletContext<ShellContext | undefined>();

  return (
    <main className="page page--home">
      <div className="page__inner">
        <header className="page__header page__header--home">
          <div className="page__lead">
            <h2 className="page__title page__title--home">Open your activity files, privately</h2>
            <p className="page__intro">
              Read a track, convert it, plan one, or draw a GoPro video’s telemetry over the
              footage. All of it in this browser tab.
            </p>
            <p className="page__actions">
              <Link className="button button--primary" to={ROUTES.viewer}>
                Open an activity
              </Link>
            </p>
          </div>

          <section className="proof" aria-labelledby="home-proof">
            <h3 className="proof__title" id="home-proof">
              Held at zero by the browser tests
            </h3>
            <dl className="proof__list">
              {PROOF.map((caption) => (
                <div key={caption} className="proof__row">
                  <dt className="proof__caption">{caption}</dt>
                  <dd className="proof__figure">
                    0 <span className="proof__unit">allowed</span>
                  </dd>
                </div>
              ))}
            </dl>
            <a className="link proof__link" href={PRIVACY_MODEL_URL} target="_blank" rel="noopener noreferrer">
              How this is tested, on GitHub
            </a>
          </section>
        </header>

        <section className="prose" aria-labelledby="home-tools">
          <h3 className="prose__title" id="home-tools">
            Tools
          </h3>
          <ul className="tool-list">
            {TOOLS.map((tool) => (
              <li key={tool.to} className="tool">
                {/* The name is the link; it stretches over the whole row, so the
                    description is part of the target without joining the name. */}
                <Link className="tool__name" to={tool.to}>
                  {tool.label}
                  <ToolArrow />
                </Link>
                <span className="tool__detail">{tool.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="home-pair">
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
              can turn the basemap off in{' '}
              {shell ? (
                <button type="button" className="link link--button" onClick={shell.openSettings}>
                  Settings
                </button>
              ) : (
                'Settings'
              )}{' '}
              and draw the route on a plain background instead, which makes no external request at
              all.
            </p>
            <p>
              This is tested, not just promised. The{' '}
              <a className="link" href={PRIVACY_TEST_URL} target="_blank" rel="noopener noreferrer">
                browser test suite (GitHub)
              </a>{' '}
              runs on every change and fails if any of the three figures at the top of this page is
              not zero.
            </p>
            <p>
              <Link className="link" to={ROUTES.terms}>
                Read the Terms and Conditions
              </Link>
            </p>
          </section>

          <section className="prose">
            <h3 className="prose__title">Formats</h3>
            <ul className="format-list">
              {FORMATS.map((format) => (
                <li key={format.name} className="format">
                  <span className="format__name">{format.name}</span>
                  <span className="format__access">{format.access}</span>
                  <span className="format__detail">{format.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}
