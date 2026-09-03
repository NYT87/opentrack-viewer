import { describe, expect, it } from 'vitest';
import {
  MISSING,
  elevationUnitLabel,
  toDisplayElevation,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatElevation,
  formatFileSize,
  formatSpeed,
} from './units';

describe('formatDistance', () => {
  it('uses meters below a kilometer and kilometers above', () => {
    expect(formatDistance(950)).toBe('950 m');
    expect(formatDistance(1500)).toBe('1.50 km');
  });

  it('supports imperial units', () => {
    expect(formatDistance(1609.344, 'imperial')).toBe('1.00 mi');
    expect(formatDistance(30, 'imperial')).toBe('98 ft');
  });

  it('renders missing values explicitly', () => {
    expect(formatDistance(undefined)).toBe(MISSING);
    expect(formatDistance(Number.NaN)).toBe(MISSING);
  });
});

describe('formatDuration', () => {
  it('formats under and over an hour', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('rejects missing and negative values', () => {
    expect(formatDuration(undefined)).toBe(MISSING);
    expect(formatDuration(-5)).toBe(MISSING);
  });
});

describe('formatElevation', () => {
  it('rounds to whole units', () => {
    expect(formatElevation(123.4)).toBe('123 m');
    expect(formatElevation(304.8, 'imperial')).toBe('1000 ft');
  });
});

describe('toDisplayElevation', () => {
  it('passes metres through unchanged', () => {
    expect(toDisplayElevation(123.4, 'metric')).toBe(123.4);
  });

  it('converts to feet for imperial', () => {
    expect(toDisplayElevation(304.8, 'imperial')).toBeCloseTo(1000);
  });
});

describe('elevationUnitLabel', () => {
  it('names the unit for each system', () => {
    expect(elevationUnitLabel('metric')).toBe('m');
    expect(elevationUnitLabel('imperial')).toBe('ft');
  });
});

describe('formatSpeed', () => {
  it('converts meters per second', () => {
    expect(formatSpeed(10)).toBe('36.0 km/h');
    expect(formatSpeed(10, 'imperial')).toBe('22.4 mph');
  });
});

describe('formatDateTime', () => {
  it('rejects invalid dates', () => {
    expect(formatDateTime(undefined)).toBe(MISSING);
    expect(formatDateTime(new Date('nope'))).toBe(MISSING);
  });

  it('formats a valid date', () => {
    expect(formatDateTime(new Date('2024-01-01T10:00:00Z'))).not.toBe(MISSING);
  });
});

describe('formatFileSize', () => {
  it('scales through B, KB and MB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
