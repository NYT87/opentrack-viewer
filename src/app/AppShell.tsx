import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { SettingsIconButton } from '../components/SettingsIconButton';
import { ToolsMenu } from '../components/ToolsMenu';
import { SettingsModal } from '../components/SettingsModal';
import { SiteFooter } from '../components/SiteFooter';
import { useActivityStore } from '../state/activityStore';
import { ROUTES, TOOLS_ITEMS } from './routes';
import { useAppTheme } from './useAppTheme';
import { useRouteMetadata } from './useRouteMetadata';

/**
 * What the shell offers the page it routes to. Home names Settings in its
 * privacy copy, and the name should open the dialog it names.
 */
export interface ShellContext {
  openSettings: () => void;
}

/**
 * AV-003 / AV-006. Layout chrome shared by every page: header with navigation,
 * the routed page, and the site footer.
 */
export function AppShell() {
  useAppTheme();
  // AV-013: title and social tags follow the route, and describe the app only.
  useRouteMetadata();

  const location = useLocation();
  const isHome = location.pathname === ROUTES.home;

  /*
   * A route change scrolls to the top and moves focus to the new page's title, so a screen reader
   * hears where it is and Tab starts from the page, not the top of the shell.
   * Only when the page left focus nowhere useful (the body, or the header that
   * navigated): a page that puts focus somewhere itself keeps it. Not on the
   * first load, where the browser's own start is right.
   */
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    // A new page starts at its top, not wherever the last one was scrolled to.
    window.scrollTo(0, 0);
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest('.shell__header')) return;
      const title = document.querySelector<HTMLElement>('main h2');
      if (!title) return;
      if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [location.pathname]);

  const activity = useActivityStore((state) => state.activity);
  const clear = useActivityStore((state) => state.clear);

  // Modal state lives here rather than in the router, so opening settings
  // leaves the route and the mounted viewer untouched (AV-007).
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const shellContext: ShellContext = { openSettings: () => setIsSettingsOpen(true) };

  return (
    <div className="shell">
      <header className="shell__header">
        {/* AV-010: the brand is the way home, so there is no Home nav item. */}
        <div className="shell__lead">
          <h1 className="shell__title">
            {/*
              On a phone the brand shortens to the product's short name, so the
              header holds one line; the link keeps its full name throughout.
            */}
            <Link className="shell__brand" to={ROUTES.home} aria-label="OpenTrack Viewer">
              OpenTrack<span className="shell__brand-rest"> Viewer</span>
            </Link>
          </h1>

          {/* AV-012: navigation lives here, beside the title. */}
          <ToolsMenu
            items={TOOLS_ITEMS.map((item) => ({
              ...item,
              isCurrent: location.pathname === item.to,
            }))}
          />
        </div>

        <div className="shell__actions">
          {/*
            Closing an activity is scoped to having one: the homepage owns no
            activity state, so the control would act on nothing.
          */}
          {!isHome && activity && (
            <button type="button" className="button shell__close" onClick={clear}>
              Close activity
            </button>
          )}

          {/*
            AV-007 / TD-008: Settings belongs in the global header on *every*
            page, the homepage included. Units and theme are app-wide choices,
            and a reader who wants dark mode should not have to open a file to
            find the switch.
          */}
          <SettingsIconButton onClick={() => setIsSettingsOpen(true)} />
        </div>
      </header>

      {/*
        The header is a fixed band; everything below it scrolls as one region
        with the footer at the end of the content, so the footer is only seen
        once the reader reaches the bottom.
      */}
      <div className="shell__scroll">
        <div className="shell__body">
          <Outlet context={shellContext} />
        </div>

        <SiteFooter />
      </div>

      {isSettingsOpen && <SettingsModal onClose={() => setIsSettingsOpen(false)} />}
    </div>
  );
}
