import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { HomePage } from './HomePage';
import { ViewerPage } from './ViewerPage';
import { ROUTES } from './routes';

/**
 * HashRouter rather than BrowserRouter: this is a static, backend-free app
 * (TD-001) and is likely to be served from static hosting such as GitHub Pages,
 * where a deep link to /settings would 404 without server rewrites.
 */
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path={ROUTES.home} element={<HomePage />} />
          <Route path={ROUTES.viewer} element={<ViewerPage />} />
          {/* Unknown hashes land on the homepage rather than a blank screen. */}
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
