import type { Activity, ActivityPointRange, ActivityWarning } from '../domain/activity';
import { sliceActivity } from '../domain/activitySlice';
import { ActivityError } from '../domain/errors';
import { buildGpx } from './gpx/buildGpx';
import { buildTcx } from './tcx/buildTcx';

/** Formats this build can write. */
export type ExportFormat = 'gpx' | 'fit' | 'tcx';

export interface ExportFormatDefinition {
  format: ExportFormat;
  /** Shown in the UI. */
  label: string;
  extension: string;
  mimeType: string;
}

export const EXPORT_FORMATS: ExportFormatDefinition[] = [
  { format: 'gpx', label: 'GPX', extension: 'gpx', mimeType: 'application/gpx+xml' },
  { format: 'fit', label: 'FIT', extension: 'fit', mimeType: 'application/vnd.ant.fit' },
  {
    format: 'tcx',
    label: 'TCX',
    extension: 'tcx',
    mimeType: 'application/vnd.garmin.tcx+xml',
  },
];

export interface ExportOptions {
  format: ExportFormat;
  /**
   * Write only this span of points. Omitted means the whole activity — the same
   * distinction the chart panel already draws between a focused range and the
   * full track (AV-509).
   */
  range?: ActivityPointRange;
  /** Overrides the derived name, without its extension. */
  baseName?: string;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  /** What the chosen format could not carry cleanly. */
  warnings: ActivityWarning[];
}

/**
 * A serializer returns the file's bytes in whatever form suits the format —
 * text for GPX, a byte array for FIT — plus what that format could not carry.
 *
 * Async by contract so a format can be loaded on demand. FIT is: its encoder
 * lives in the same package as the FIT parser, and someone exporting GPX should
 * not pay for it (TD-021).
 */
type SerializedBody = string | Uint8Array;
type Serializer = (
  activity: Activity,
) => Promise<{ body: SerializedBody; warnings: ActivityWarning[] }>;

const SERIALIZERS: Record<ExportFormat, Serializer> = {
  gpx: async (activity) => {
    const { xml, warnings } = buildGpx(activity);
    return { body: xml, warnings };
  },
  tcx: async (activity) => {
    const { xml, warnings } = buildTcx(activity);
    return { body: xml, warnings };
  },
  fit: async (activity) => {
    const { buildFit } = await import('./fit/buildFit');
    const { bytes, warnings } = buildFit(activity);
    return { body: bytes, warnings };
  },
};

/**
 * AV-550. Turns a normalized activity into a downloadable file.
 *
 * Everything happens in this tab: the result is a `Blob` built from a string,
 * and nothing here opens a network connection. An exporter reads the normalized
 * model only, never a parser's output, so what gets written does not depend on
 * which format the activity was read from (TD-002).
 */
export async function exportActivity(
  activity: Activity,
  options: ExportOptions,
): Promise<ExportResult> {
  const definition = EXPORT_FORMATS.find((entry) => entry.format === options.format);
  const serialize = SERIALIZERS[options.format] as Serializer | undefined;

  if (!definition || !serialize) {
    throw new ActivityError(
      'unsupported_format',
      `${String(options.format).toUpperCase()} is not a format this build can write.`,
    );
  }

  const source = resolveSource(activity, options.range);
  const { body, warnings } = await serialize(source.activity);
  // A charset applies to the text formats only; FIT is bytes.
  const type =
    typeof body === 'string' ? `${definition.mimeType};charset=utf-8` : definition.mimeType;

  return {
    // A fresh copy of the bytes: `Blob` accepts a view, and handing it one that
    // shares a buffer with anything else invites a surprise later.
    blob: new Blob([typeof body === 'string' ? body : new Uint8Array(body)], { type }),
    fileName: `${options.baseName ?? deriveBaseName(activity, source.isRange)}.${definition.extension}`,
    mimeType: definition.mimeType,
    warnings,
  };
}

function resolveSource(
  activity: Activity,
  range: ActivityPointRange | undefined,
): { activity: Activity; isRange: boolean } {
  if (!range) return { activity, isRange: false };

  const sliced = sliceActivity(activity, range);
  if (!sliced.ok) throw sliced.error;
  return { activity: sliced.activity, isRange: true };
}

/**
 * A file name the user will recognize in their downloads folder: the activity's
 * own name where it has one, otherwise the file they opened.
 */
function deriveBaseName(activity: Activity, isRange: boolean): string {
  const fromSource = activity.source.fileName?.replace(/\.[^.]+$/, '');
  const raw = activity.metadata.name?.trim() || fromSource || 'activity';
  // An allowlist, not a denylist: the name came out of a file, so it can hold
  // path separators, control characters or anything else a file system objects
  // to. The full name still lives inside the exported document.
  const safe =
    raw
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || 'activity';

  return isRange ? `${safe}-section` : safe;
}
