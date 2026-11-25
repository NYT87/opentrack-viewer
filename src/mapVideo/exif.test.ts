import { describe, expect, it } from 'vitest';
import { photoTakenAt, readPhotoExif } from './exif';
import { heicLikeWithExif, jpegWithExif, tiffBlock } from '../test/helpers/exifFixture';

const camera = { dateTimeOriginal: '2026:09:24 09:12:33', offsetTimeOriginal: '+09:00', lat: 34.0661, lon: 132.9978 };

describe('reading a photo\'s EXIF (AV-1208)', () => {
  it('reads the time taken, its offset and the position from a JPEG', () => {
    expect(readPhotoExif(jpegWithExif(camera))).toEqual({
      localTime: '2026-09-24T09:12:33',
      utcOffsetMinutes: 540,
      lat: expect.closeTo(34.0661, 6),
      lon: expect.closeTo(132.9978, 6),
    });
  });

  it('reads big-endian TIFF, and southern and western positions', () => {
    const read = readPhotoExif(jpegWithExif({ ...camera, offsetTimeOriginal: '-05:30', lat: -33.86, lon: -70.65, littleEndian: false }));
    expect(read).toMatchObject({ utcOffsetMinutes: -330, lat: expect.closeTo(-33.86, 6), lon: expect.closeTo(-70.65, 6) });
  });

  it('reads PNG\'s eXIf chunk and a HEIC\'s Exif item', () => {
    const tiff = tiffBlock(camera);
    const chunk = [0, 0, (tiff.length >> 8) & 0xff, tiff.length & 0xff, ...[...'eXIf'].map((c) => c.charCodeAt(0)), ...tiff, 0, 0, 0, 0];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk]);
    expect(readPhotoExif(png).localTime).toBe('2026-09-24T09:12:33');
    expect(readPhotoExif(heicLikeWithExif(camera)).lat).toBeCloseTo(34.0661, 6);
  });

  it('reads nothing from a file without EXIF, or with a broken one, and never throws', () => {
    expect(readPhotoExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({});
    expect(readPhotoExif(new TextEncoder().encode('not a photo'))).toEqual({});
    const broken = jpegWithExif(camera).slice(0, 30);
    expect(() => readPhotoExif(broken)).not.toThrow();
    expect(readPhotoExif(jpegWithExif({ dateTimeOriginal: '0000:00:00 00:00:00' }))).toEqual({});
  });

  it('takes the camera\'s own offset for the time taken, else the one given', () => {
    expect(photoTakenAt({ localTime: '2026-09-24T09:12:33', utcOffsetMinutes: 540 }, 0)).toBe(Date.parse('2026-09-24T00:12:33Z'));
    expect(photoTakenAt({ localTime: '2026-09-24T09:12:33' }, 120)).toBe(Date.parse('2026-09-24T07:12:33Z'));
    expect(photoTakenAt({ localTime: '2026-09-24T09:12:33' }, undefined)).toBeUndefined();
    expect(photoTakenAt({}, 0)).toBeUndefined();
  });
});

describe('fixes from the M10 review (TD-073)', () => {
  it('reads a date that is no date as no time, never as NaN', () => {
    expect(readPhotoExif(jpegWithExif({ dateTimeOriginal: '2026:13:10 08:00:00' })).localTime).toBeUndefined();
    expect(readPhotoExif(jpegWithExif({ dateTimeOriginal: '2026:02:31 08:00:00' })).localTime).toBeUndefined();
    expect(readPhotoExif(jpegWithExif({ dateTimeOriginal: '2026:02:28 25:00:00' })).localTime).toBeUndefined();
    expect(readPhotoExif(jpegWithExif({ dateTimeOriginal: '2024:02:29 23:59:59' })).localTime).toBe('2024-02-29T23:59:59');
  });
});
