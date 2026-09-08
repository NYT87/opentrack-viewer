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

  it('says up front that it cannot write an empty file, rather than after (AV-555)', async () => {
    const indoor = makeActivity([
      { heartRateBpm: 120, time: new Date('2024-01-01T10:00:00Z') },
      { heartRateBpm: 130, time: new Date('2024-01-01T10:01:00Z') },
    ]);
    render(<ExportPanel activity={indoor} />);

    // GPX is this activity's own format, and the one it cannot be written to.
    // The reason is stated before a press, and the press cannot happen.
    expect(screen.getByText(/GPX needs GPS coordinates/i)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /GPX/ });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(saved).toHaveLength(0);
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

  it('explains why, and refuses to be pressed, when the choice is unavailable', async () => {
    // Reaching an unavailable format needs the control set directly, which is
    // what a keyboard or a restored form state can do even with it disabled.
    render(<ExportPanel activity={indoor()} />);
    const select = screen.getByLabelText('Format') as HTMLSelectElement;

    await act(async () => {
      select.value = 'gpx';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(screen.getByText(/GPX needs GPS coordinates/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /GPX/ })).toBeDisabled();
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
