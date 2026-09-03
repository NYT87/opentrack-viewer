import { Link } from 'react-router-dom';
import { ROUTES } from '../app/routes';

/** Update if the repository is published under a different name. */
const GITHUB_URL = 'https://github.com/NYT87/opentrack-viewer';
const ISSUES_URL = `${GITHUB_URL}/issues`;
const COMPANY_URL = 'https://nyt87.github.io/';

/** Small route glyph, matching the app icon. Decorative next to the wordmark. */
function BrandMark() {
  return (
    <svg
      className="footer__mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 19c3.5 0 3.5-6 7-6s3.5 6 7 6" />
      <circle cx="3" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <path d="M14.5 6.5 18 3l3 3.5" />
    </svg>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__brand">
          <p className="footer__wordmark">
            <BrandMark />
            <span>
              <strong>OpenTrack</strong> Viewer
            </span>
          </p>
          <p className="footer__tagline">
            Open GPX activity files locally in your browser. Parsing and calculations happen on
            your device — your activity file is never uploaded.
          </p>
        </div>

        <nav className="footer__column" aria-label="App">
          <h2 className="footer__heading">App</h2>
          <ul className="footer__list">
            <li>
              <Link className="footer__link" to={ROUTES.home}>
                Home
              </Link>
            </li>
            <li>
              <Link className="footer__link" to={ROUTES.viewer}>
                Open an activity
              </Link>
            </li>
          </ul>
        </nav>

        <nav className="footer__column" aria-label="Project">
          <h2 className="footer__heading">Project</h2>
          <ul className="footer__list">
            <li>
              <a
                className="footer__link"
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </li>
            <li>
              <a
                className="footer__link"
                href={ISSUES_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Report an issue
              </a>
            </li>
          </ul>
        </nav>
      </div>

      <div className="footer__bottom">
        <p className="footer__credit">
          &copy; {year} OpenTrack Viewer. Made with{' '}
          <span className="footer__heart" role="img" aria-label="love">
            &#10084;
          </span>{' '}
          by{' '}
          <a className="link" href={COMPANY_URL} target="_blank" rel="noopener noreferrer">
            nyt87
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
