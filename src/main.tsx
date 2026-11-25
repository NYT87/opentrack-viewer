import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { removeStaleArchives } from './overlay/export/archiveSink';
import './styles/global.css';
import './styles/map.css';

const container = document.getElementById('root');
// Abandoned export files are reclaimed on the next visit, not only on export.
void removeStaleArchives();
if (!container) throw new Error('Root element #root was not found.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
