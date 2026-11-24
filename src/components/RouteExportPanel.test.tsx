import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouteExportPanel } from './RouteExportPanel';
import { addPoint, createBlankDraft, draftFromActivity, type RouteDraft } from '../domain/routeDraft';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';

let saved: { fileName: string; blob: Blob }[] = [];

function define(name: 'createObjectURL' | 'revokeObjectURL', value: unknown): void {
  Object.defineProperty(URL, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  saved = [];
  const blobs = new Map<string, Blob>();
  define('createObjectURL', (blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  define('revokeObjectURL', () => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ fileName: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

const draftOf = (fixture = 'route-with-elevation.gpx'): RouteDraft =>
  draftFromActivity(parseGpx(readFixture(fixture), { fileName: fixture }));

describe('RouteExportPanel (AV-1107)', () => {
  it('is disabled until the route has at least two points', async () => {
    const { rerender } = render(<RouteExportPanel draft={createBlankDraft()} />);
    expect(screen.getByRole('button', { name: /Export as GPX/ })).toBeDisabled();
    expect(screen.getByText(/at least two points/i)).toBeInTheDocument();

    const one = addPoint(createBlankDraft(), { lat: 1, lon: 1 });
    if (!one.ok) throw new Error('expected ok');
    rerender(<RouteExportPanel draft={one.draft} />);
    expect(screen.getByRole('button', { name: /Export as GPX/ })).toBeDisabled();

    rerender(<RouteExportPanel draft={draftOf()} />);
    expect(screen.getByRole('button', { name: /Export as GPX/ })).toBeEnabled();
  });

  it('writes a GPX that reads back as the same route', async () => {
    const draft = draftOf();
    render(<RouteExportPanel draft={draft} />);
    await userEvent.click(screen.getByRole('button', { name: /Export as GPX/ }));

    expect(saved).toHaveLength(1);
    const text = await saved[0]!.blob.text();
    const reread = parseGpx(text, { fileName: saved[0]!.fileName });
    expect(reread.points.map((p) => [p.lat, p.lon])).toEqual(
      draft.points.map((p) => [Number(p.lat.toFixed(7)), Number(p.lon.toFixed(7))]),
    );
    expect(reread.points.map((p) => p.elevationMeters)).toEqual(draft.points.map((p) => p.elevationMeters));
  });

  it('keeps a gap as a separate segment in the file', async () => {
    const base = draftOf();
    const gapped: RouteDraft = {
      ...base,
      points: base.points.map((p, i) => ({ ...p, segmentIndex: i < 2 ? 0 : 1 })),
    };
    render(<RouteExportPanel draft={gapped} />);
    await userEvent.click(screen.getByRole('button', { name: /Export as GPX/ }));
    const text = await saved[0]!.blob.text();
    expect((text.match(/<trkseg>/g) ?? []).length).toBe(2);
  });

  it('names the file as a planned route and carries no recording data', async () => {
    render(<RouteExportPanel draft={draftOf()} />);
    await userEvent.click(screen.getByRole('button', { name: /Export as GPX/ }));

    expect(saved[0]!.fileName).toMatch(/-planned-route\.gpx$/);
    expect(screen.getByRole('status')).toHaveTextContent(saved[0]!.fileName);
    const text = await saved[0]!.blob.text();
    expect(text).not.toMatch(/<time>|<gpxtpx:hr|serial/);
  });

  it('says what a plan cannot carry, before and after', async () => {
    render(<RouteExportPanel draft={draftOf()} />);
    expect(screen.getByText(/points and elevation only/i)).toBeInTheDocument();
  });

  it('offers FIT and TCX only as disabled options, with the reason', async () => {
    render(<RouteExportPanel draft={draftOf()} />);
    const select = screen.getByLabelText('Format');
    expect(screen.getByRole('option', { name: /FIT — unavailable/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: /TCX — unavailable/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'GPX' })).toBeEnabled();
    expect(select).toHaveValue('gpx');
    expect(screen.getByText(/FIT: FIT needs timestamps, and a planned route has none/)).toBeInTheDocument();
  });

  it('makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<RouteExportPanel draft={draftOf()} />);
    await userEvent.click(screen.getByRole('button', { name: /Export as GPX/ }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
