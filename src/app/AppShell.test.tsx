import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {},
    setWorkerUrl,
  };
});

const { App } = await import('./App');
const { useInteractionStore } = await import('../state/interactionStore');
const { useActivityStore } = await import('../state/activityStore');
const { fixtureFile } = await import('../test/helpers/fixtures');

// HashRouter reads window.location.hash, which jsdom keeps across tests in a
// file: without this, a test that navigated to Settings leaves the next one
// starting there.
beforeEach(() => {
  window.location.hash = '#/';
  useActivityStore.getState().clear();
  useInteractionStore.setState({
    unitSystem: 'metric',
    basemapEnabled: true,
    themeMode: 'system',
  });
});

/** The footer links to the same routes, so nav assertions target the header. */
const navLink = (name: 'Viewer') =>
  within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name });

const openSettings = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return screen.findByRole('dialog');
};

const goToViewer = async () => {
  await userEvent.click(navLink('Viewer'));
  await screen.findByTestId('file-input');
};

describe('routing (AV-006)', () => {
  it('renders the homepage at the root route', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: /open your activity files/i })).toBeInTheDocument();
    // The homepage owns no activity state.
    expect(screen.queryByTestId('file-input')).not.toBeInTheDocument();
  });

  it('describes the privacy model and the supported formats', () => {
    render(<App />);

    expect(screen.getByText(/no backend, no account and no upload/i)).toBeInTheDocument();
    expect(screen.getByText('GPX')).toBeInTheDocument();
    expect(screen.getByText('FIT')).toBeInTheDocument();
    expect(screen.getByText('TCX')).toBeInTheDocument();
    expect(screen.getAllByText('Planned').length).toBeGreaterThan(0);
  });

  it('reaches the viewer from the homepage', async () => {
    render(<App />);

    await goToViewer();

    expect(window.location.hash).toBe('#/viewer');
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('offers a primary call to action on the homepage', async () => {
    render(<App />);

    // Scoped to the page: the footer carries the same link.
    const main = within(screen.getByRole('main'));
    await userEvent.click(main.getByRole('link', { name: 'Open an activity' }));

    expect(await screen.findByTestId('file-input')).toBeInTheDocument();
  });

  it('marks the current page in the navigation', async () => {
    render(<App />);
    expect(navLink('Viewer')).not.toHaveAttribute('aria-current');

    await goToViewer();

    expect(navLink('Viewer')).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to the homepage for an unknown route', async () => {
    window.location.hash = '#/nowhere';
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: /open your activity files/i }),
    ).toBeInTheDocument();
  });
});

describe('header (AV-010)', () => {
  const brand = () => screen.getByRole('link', { name: 'OpenTrack Viewer' });

  it('uses the brand as the link home, with no duplicate Home item', async () => {
    render(<App />);
    await goToViewer();

    // AV-010 scopes this to the header; the footer's own Home link is fine.
    const header = within(screen.getByRole('banner'));
    expect(header.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();

    await userEvent.click(brand());

    expect(window.location.hash).toBe('#/');
    expect(
      await screen.findByRole('heading', { name: /open your activity files/i }),
    ).toBeInTheDocument();
  });

  it('drops the descriptive subtitle from global chrome', () => {
    render(<App />);

    expect(screen.queryByText(/your activity file stays on your device/i)).not.toBeInTheDocument();
  });

  it('keeps the viewer reachable without a Home button', () => {
    render(<App />);

    expect(navLink('Viewer')).toBeInTheDocument();
  });

  it('renders Settings as an icon-only control with an accessible name', async () => {
    render(<App />);
    await goToViewer();

    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings).toHaveAttribute('title', 'Settings');
    // Icon only: no visible label text to read out twice.
    expect(settings.textContent).toBe('');
    expect(settings.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens the modal from the keyboard', async () => {
    render(<App />);
    await goToViewer();

    screen.getByRole('button', { name: 'Settings' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('settings modal (AV-007)', () => {
  it('is not offered on the homepage', () => {
    render(<App />);

    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('is offered in the header on the viewer page', async () => {
    render(<App />);
    await goToViewer();

    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('opens as a dialog without changing the route', async () => {
    render(<App />);
    await goToViewer();

    const dialog = await openSettings();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Settings');
    expect(window.location.hash).toBe('#/viewer');
  });

  it('leaves the viewer mounted underneath', async () => {
    render(<App />);
    await goToViewer();

    await openSettings();

    // The drop zone belongs to the viewer, so its presence proves the page
    // was not unmounted or replaced by a settings route.
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('moves focus into the dialog and returns it to the opener on close', async () => {
    render(<App />);
    await goToViewer();
    const opener = screen.getByRole('button', { name: 'Settings' });

    const dialog = await openSettings();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Escape', async () => {
    render(<App />);
    await goToViewer();
    await openSettings();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('traps Tab inside the dialog', async () => {
    render(<App />);
    await goToViewer();
    const dialog = await openSettings();

    // Cycle past the last control; focus must stay within the dialog.
    for (let i = 0; i < 6; i += 1) await userEvent.tab();

    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes on a backdrop click', async () => {
    render(<App />);
    await goToViewer();
    const dialog = await openSettings();
    const backdrop = dialog.parentElement!;

    await userEvent.click(backdrop);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('survives a drag that starts inside the dialog and ends on the backdrop', async () => {
    // Regression: dismissing on mousedown alone closed the dialog mid-drag,
    // for instance when selecting help text and releasing outside it.
    render(<App />);
    await goToViewer();
    const dialog = await openSettings();
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(dialog);
    fireEvent.click(backdrop);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('holds the session settings controls', async () => {
    render(<App />);
    await goToViewer();
    await openSettings();

    expect(screen.getByLabelText('Units')).toBeInTheDocument();
    expect(screen.getByLabelText('Basemap tiles')).toBeInTheDocument();
    expect(screen.getByText(/nothing is saved to your device/i)).toBeInTheDocument();
  });

  it('writes preferences to the shared store', async () => {
    render(<App />);
    await goToViewer();
    await openSettings();

    await userEvent.selectOptions(screen.getByLabelText('Units'), 'imperial');
    await userEvent.click(screen.getByLabelText('Basemap tiles'));

    expect(useInteractionStore.getState().unitSystem).toBe('imperial');
    expect(useInteractionStore.getState().basemapEnabled).toBe(false);
  });
});

describe('theme (AV-009)', () => {
  const themeRadio = (name: 'System' | 'Dark' | 'Light') =>
    screen.getByRole('radio', { name });

  /** jsdom has no real colour-scheme preference; this stands in for the OS. */
  const stubPrefersDark = (matches: boolean) => {
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      })),
    );
    return listeners;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-theme');
  });

  it('offers exactly three modes as a single-choice group', async () => {
    render(<App />);
    await goToViewer();
    await openSettings();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // One shared name means the browser enforces single choice for us.
    expect(new Set(radios.map((radio) => radio.getAttribute('name'))).size).toBe(1);
    expect(themeRadio('System')).toBeChecked();
  });

  it('follows the system preference by default', () => {
    stubPrefersDark(true);
    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('falls back to light when the preference cannot be detected', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<App />);

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('forces an explicit mode over the system preference', async () => {
    stubPrefersDark(true);
    render(<App />);
    await goToViewer();
    await openSettings();

    await userEvent.click(themeRadio('Light'));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(useInteractionStore.getState().themeMode).toBe('light');
  });

  it('applies immediately, without navigating or clearing the activity', async () => {
    render(<App />);
    await goToViewer();
    await userEvent.upload(screen.getByTestId('file-input'), fixtureFile('simple-route.gpx'));
    await screen.findByText('Simple Route');

    await openSettings();
    await userEvent.click(themeRadio('Dark'));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.location.hash).toBe('#/viewer');
    expect(screen.getByText('Simple Route')).toBeInTheDocument();
  });

  it('keeps following the OS after it changes while in system mode', () => {
    const listeners = stubPrefersDark(false);
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe('light');

    // The OS flips to dark: system mode must follow without any interaction.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    act(() => listeners.forEach((fn) => fn()));

    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('SiteFooter', () => {
  it('credits nyt87 and links to the company site', () => {
    render(<App />);

    const link = screen.getByRole('link', { name: 'nyt87' });
    expect(link).toHaveAttribute('href', 'https://nyt87.github.io/');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('groups links under headed columns', () => {
    render(<App />);

    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByRole('heading', { name: 'App' })).toBeInTheDocument();
    expect(footer.getByRole('heading', { name: 'Project' })).toBeInTheDocument();
    expect(footer.getByRole('navigation', { name: 'App' })).toBeInTheDocument();
    expect(footer.getByRole('navigation', { name: 'Project' })).toBeInTheDocument();
  });

  it('carries the brand and the privacy promise', () => {
    render(<App />);

    const footer = screen.getByRole('contentinfo');
    // The wordmark splits the name across elements, so assert on the whole.
    expect(footer).toHaveTextContent('OpenTrack Viewer');
    expect(footer).toHaveTextContent(/never uploaded/i);
  });

  it('shows the current year in the copyright line', () => {
    render(<App />);

    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      new RegExp(`\\u00a9 ${new Date().getFullYear()} OpenTrack Viewer`),
    );
  });

  it('labels the heart for screen readers', () => {
    render(<App />);

    expect(within(screen.getByRole('contentinfo')).getByRole('img', { name: 'love' })).toBeInTheDocument();
  });

  it('links to the issue tracker', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: 'Report an issue' })).toHaveAttribute(
      'href',
      'https://github.com/NYT87/opentrack-viewer/issues',
    );
  });

  it('links to the GitHub repository', () => {
    render(<App />);

    const link = screen.getByRole('link', { name: 'GitHub' });
    expect(link).toHaveAttribute('href', 'https://github.com/NYT87/opentrack-viewer');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('is present on the viewer page too', async () => {
    render(<App />);
    await goToViewer();

    expect(screen.getByRole('link', { name: 'nyt87' })).toBeInTheDocument();
  });
});
