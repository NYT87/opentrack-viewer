import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportPanel } from './ExportPanel';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';
import { makeActivity } from '../test/helpers/activity';
import { parseFit } from '../parsers/fit/parseFit';
import { readBinaryFixture } from '../test/helpers/fixtures';

const activity = parseGpx(readFixture('route-with-elevation.gpx'), {
  fileName: 'route-with-elevation.gpx',
});

/** Captures what the browser was asked to save, without a real download. */
let saved: { fileName: string; blob: Blob }[] = [];

function define(name: 'createObjectURL' | 'revokeObjectURL', value: unknown): void {
  Object.defineProperty(URL, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  saved = [];
  const blobs = new Map<string, Blob>();

  // Only the two methods, never the whole global: `URL` must stay a real
  // constructor, because loading a format's writer on demand needs `new URL`.
  define('createObjectURL', (blob: Blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  define('revokeObjectURL', () => {});

  // jsdom does not navigate, so a click on a download anchor is the signal.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ fileName: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

describe('ExportPanel (AV-554)', () => {
  it('offers the formats the build can write', () => {
    render(<ExportPanel activity={activity} />);

    expect(screen.getByLabelText('Format')).toHaveValue('gpx');
    // AV-555: the file's own format is offered, and named for what it is.
    expect(screen.getByRole('option', { name: 'GPX (same format)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'TCX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rewrite as GPX' })).toBeInTheDocument();
  });

  it('saves a file the browser can download', async () => {
    render(<ExportPanel activity={activity} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rewrite as GPX' }));

    expect(saved).toHaveLength(1);
    expect(saved[0]!.fileName).toBe('Elevation-Route.gpx');
    expect(await saved[0]!.blob.text()).toContain('<trkpt');
    expect(screen.getByText(/Saved/)).toHaveTextContent('Elevation-Route.gpx');
  });

  it('offers no scope choice when nothing is selected', () => {
    render(<ExportPanel activity={activity} />);

    expect(screen.queryByText('Selected section')).not.toBeInTheDocument();
  });

  it('lets the user choose the whole activity or the selection (AV-509)', async () => {
    render(<ExportPanel activity={activity} selectedRange={{ startIndex: 1, endIndex: 2 }} />);

    // The selection is the default, because it is what the user just made.
    await userEvent.click(screen.getByRole('button', { name: 'Rewrite as GPX' }));
    expect(saved[0]!.fileName).toBe('Elevation-Route-section.gpx');
    expect((await saved[0]!.blob.text()).match(/<trkpt/g)).toHaveLength(2);

    await userEvent.click(screen.getByRole('radio', { name: 'Whole activity' }));
    await userEvent.click(screen.getByRole('button', { name: 'Rewrite as GPX' }));

    expect(saved[1]!.fileName).toBe('Elevation-Route.gpx');
    expect((await saved[1]!.blob.text()).match(/<trkpt/g)).toHaveLength(activity.points.length);
  });

  it('writes the format the user chose', async () => {
    render(<ExportPanel activity={activity} />);

    await userEvent.selectOptions(screen.getByLabelText('Format'), 'fit');
    // A different target is a conversion, and says so.
    await userEvent.click(screen.getByRole('button', { name: 'Convert to FIT' }));

    // The FIT writer is loaded on demand, so the file arrives after the click.
    await screen.findByText(/Saved/);
    expect(saved[0]!.fileName).toBe('Elevation-Route.fit');
    const bytes = new Uint8Array(await saved[0]!.blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
  });

  it('names what the format could not carry', async () => {
    const withLaps = { ...activity, laps: [{ index: 0 }, { index: 1 }] };
    render(<ExportPanel activity={withLaps} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rewrite as GPX' }));

    expect(screen.getByText(/could not carry/)).toBeInTheDocument();
    expect(screen.getByText(/GPX has no lap structure/)).toBeInTheDocument();
  });

  it('says nothing about loss when there is none', async () => {
    const clean = parseGpx(readFixture('simple-route.gpx'), { fileName: 'simple-route.gpx' });
    render(<ExportPanel activity={clean} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rewrite as GPX' }));

    expect(screen.getByText(/Saved/)).toBeInTheDocument();
    expect(screen.queryByText(/could not carry/)).not.toBeInTheDocument();
  });

  it('opens on a format it can write, and says up front which one it cannot (AV-555, TD-056)', () => {
    const indoor = makeActivity([
      { heartRateBpm: 120, time: new Date('2024-01-01T10:00:00Z') },
      { heartRateBpm: 130, time: new Date('2024-01-01T10:01:00Z') },
    ]);
    render(<ExportPanel activity={indoor} />);

    // GPX is this activity's own format, and the one it cannot be written to.
    // It is listed as unavailable before any press, and the panel does not
    // open on it: a converter's first sight is a button that works.
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    expect(select.value).not.toBe('gpx');
    expect(screen.getByRole('option', { name: /GPX .*unavailable/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Convert to / })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /GPX/ })).not.toBeInTheDocument();
  });
});

describe('a rewrite is not a conversion (AV-555)', () => {
  it('offers the source format first, named as a rewrite', () => {
    render(<ExportPanel activity={activity} />);

    expect(screen.getByLabelText('Format')).toHaveValue('gpx');
    expect(screen.getByRole('button', { name: 'Rewrite as GPX' })).toBeInTheDocument();
    expect(screen.getByText(/not copied from your GPX file/)).toBeInTheDocument();
  });

  it('calls a different target a conversion', async () => {
    render(<ExportPanel activity={activity} />);

    await userEvent.selectOptions(screen.getByLabelText('Format'), 'tcx');

    expect(screen.getByRole('button', { name: 'Convert to TCX' })).toBeInTheDocument();
    expect(screen.queryByText(/not copied from your/)).not.toBeInTheDocument();
    expect(screen.getByText(/through the same activity model/)).toBeInTheDocument();
  });

  it('follows the format the file actually arrived in', async () => {
    const fit = await parseFit(readBinaryFixture('ride-with-sensors.fit'), {
      fileName: 'ride-with-sensors.fit',
    });
    render(<ExportPanel activity={fit} />);

    // A FIT file defaults to FIT, and GPX becomes the conversion.
    expect(screen.getByLabelText('Format')).toHaveValue('fit');
    expect(screen.getByRole('option', { name: 'FIT (same format)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rewrite as FIT' })).toBeInTheDocument();
  });
});

describe('a target that cannot be written is disabled, not broken (AV-555)', () => {
  const indoor = () =>
    makeActivity([
      { heartRateBpm: 120, time: new Date('2024-01-01T10:00:00Z') },
      { heartRateBpm: 130, time: new Date('2024-01-01T10:01:00Z') },
    ]);

  it('disables the option and marks it, rather than letting it be chosen', () => {
    render(<ExportPanel activity={indoor()} />);

    const gpx = screen.getByRole('option', { name: /GPX/ }) as HTMLOptionElement;
    expect(gpx.disabled).toBe(true);
    expect(gpx.textContent).toMatch(/unavailable/i);

    // The formats it *can* be written to are untouched.
    expect((screen.getByRole('option', { name: /^FIT/ }) as HTMLOptionElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole('option', { name: /^TCX/ }) as HTMLOptionElement).disabled).toBe(
      false,
    );
  });

  it('does not keep an unavailable choice, even when the control is set directly', async () => {
    // Reaching an unavailable format needs the control set directly, which is
    // what a keyboard or a restored form state can do even with it disabled.
    render(<ExportPanel activity={indoor()} />);
    const select = screen.getByLabelText('Format') as HTMLSelectElement;

    await act(async () => {
      select.value = 'gpx';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The unwritable pick does not stick: the panel stays on a format it can
    // write, and no GPX is ever offered to be pressed.
    expect(select.value).not.toBe('gpx');
    expect(screen.queryByRole('button', { name: /GPX/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Convert to / })).toBeEnabled();
    expect(saved).toHaveLength(0);
  });

  it('offers everything for an activity that has both position and time', () => {
    render(<ExportPanel activity={activity} />);

    for (const option of screen.getAllByRole('option')) {
      expect((option as HTMLOptionElement).disabled, option.textContent ?? '').toBe(false);
      expect(option.textContent).not.toMatch(/unavailable/i);
    }
  });
});

describe('ExportPanel with a KML source (AV-762)', async () => {
  const { parseKml } = await import('../parsers/kml/parseKml');
  const route = parseKml(readFixture('route-linestring.kml'), { fileName: 'route-linestring.kml' });
  const track = parseKml(readFixture('track-timed.kml'), { fileName: 'track-timed.kml' });

  it('defaults to GPX and names the action a conversion, since KML is not written', () => {
    render(<ExportPanel activity={route} />);

    expect(screen.getByLabelText('Format')).toHaveValue('gpx');
    expect(screen.queryByRole('option', { name: /KML/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /same format/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert to GPX' })).toBeEnabled();
    expect(screen.getByText(/rather than translated from KML directly/)).toBeInTheDocument();
  });

  it('disables the targets an untimed route cannot satisfy', () => {
    render(<ExportPanel activity={route} />);

    // Disabled in the list, so a reader cannot pick a format that would then
    // refuse; the reason is the exporter's own, tested with the registry.
    expect(screen.getByRole('option', { name: 'FIT — unavailable' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'TCX — unavailable' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'GPX' })).toBeEnabled();
  });

  it('offers every target for a timed track and downloads the conversion', async () => {
    const user = userEvent.setup();
    render(<ExportPanel activity={track} />);

    expect(screen.getByRole('option', { name: 'TCX' })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText('Format'), 'tcx');
    await user.click(screen.getByRole('button', { name: 'Convert to TCX' }));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.fileName).toBe('Morning-track.tcx');
    expect(await saved[0]?.blob.text()).toContain('<TrainingCenterDatabase');
  });
});
