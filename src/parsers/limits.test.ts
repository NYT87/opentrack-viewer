import { describe, expect, it, vi } from 'vitest';
import { parseActivityFile } from './index';
import { parseGpx } from './gpx/parseGpx';
import { parseTcx } from './tcx/parseTcx';
import { parseKml } from './kml/parseKml';
import { assertPointCount, MAX_ACTIVITY_FILE_BYTES, MAX_ACTIVITY_POINTS, MAX_XML_DEPTH } from './limits';

describe('import resource boundaries', () => {
  it('refuses oversized files before even sniffing their bytes', async () => {
    const slice = vi.fn(); const text = vi.fn(); const arrayBuffer = vi.fn();
    await expect(parseActivityFile({ size: MAX_ACTIVITY_FILE_BYTES + 1, name: 'huge.gpx', slice, text, arrayBuffer } as unknown as File))
      .rejects.toMatchObject({ code: 'import_limit_exceeded' });
    expect(slice).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('bounds point counts without allocating a huge recording', () => {
    expect(() => assertPointCount(MAX_ACTIVITY_POINTS)).not.toThrow();
    expect(() => assertPointCount(MAX_ACTIVITY_POINTS + 1)).toThrow(/250,000/);
  });

  it.each([
    ['gpx', parseGpx], ['tcx', parseTcx], ['kml', parseKml],
  ] as const)('refuses %s declarations before calling DOMParser', (format, parse) => {
    const parseFromString = vi.fn();
    expect(() => parse('<!DOCTYPE x [<!ENTITY x "value">]><x/>', { domParser: { parseFromString } as unknown as DOMParser }))
      .toThrow(expect.objectContaining({ code: `invalid_${format}_xml` }));
    expect(parseFromString).not.toHaveBeenCalled();
  });

  it('rejects deeply nested GPX before recursive extension readers run', () => {
    const xml = `<gpx><extensions>${'<x>'.repeat(MAX_XML_DEPTH)}value${'</x>'.repeat(MAX_XML_DEPTH)}</extensions></gpx>`;
    expect(() => parseGpx(xml)).toThrow(expect.objectContaining({ code: 'import_limit_exceeded' }));
  });
});
