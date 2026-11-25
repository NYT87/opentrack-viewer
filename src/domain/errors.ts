/**
 * Typed error categories (plan §15). Every user-facing failure maps to one of
 * these so the UI can explain what the user can do next.
 */
export type ActivityErrorCode =
  | 'unsupported_format'
  | 'import_limit_exceeded'
  | 'invalid_gpx_xml'
  | 'no_route_points'
  | 'no_location_stream'
  | 'map_style_load_failed'
  | 'fit_parse_failed'
  | 'invalid_tcx_xml'
  | 'invalid_kml_xml'
  | 'gopro_extract_failed'
  | 'no_telemetry_track'
  | 'no_video_index'
  | 'extraction_cancelled'
  | 'large_file_slow_parse'
  | 'invalid_selected_range'
  | 'file_read_failed';

const HINTS: Record<ActivityErrorCode, string> = {
  import_limit_exceeded: 'Split or simplify the file and try again.',
  unsupported_format: 'Try a .gpx, .fit, .tcx or .kml file.',
  invalid_gpx_xml: 'The file could not be read as GPX XML. It may be truncated or corrupted.',
  no_route_points: 'The file parsed, but contained no track points to display.',
  no_location_stream: 'This activity has no GPS coordinates, so no route can be drawn.',
  map_style_load_failed: 'The basemap could not load. The route is still available.',
  fit_parse_failed: 'The FIT file could not be decoded.',
  invalid_tcx_xml: 'The file could not be read as TCX XML. It may be truncated or corrupted.',
  invalid_kml_xml: 'The file could not be read as KML XML. It may be truncated, corrupted, or carry a DTD.',
  gopro_extract_failed: 'The GoPro telemetry in this video could not be read.',
  no_telemetry_track: 'This video carries no GoPro telemetry track.',
  no_video_index: 'This video has no index of its tracks. The recording may never have been finished.',
  extraction_cancelled: 'Reading the video was stopped.',
  large_file_slow_parse: 'This file is large and may take a moment to parse.',
  invalid_selected_range: 'Select a longer section of the activity.',
  file_read_failed: 'The file could not be read from your device. Try selecting it again.',
};

export class ActivityError extends Error {
  readonly code: ActivityErrorCode;
  /** Short, actionable next step for the user. */
  readonly hint: string;

  constructor(code: ActivityErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ActivityError';
    this.code = code;
    this.hint = HINTS[code];
  }
}

export function isActivityError(value: unknown): value is ActivityError {
  return value instanceof ActivityError;
}

/**
 * Normalizes anything thrown during intake/parsing into an ActivityError.
 * Raw file contents are never included in the message (privacy constraint §5).
 */
export function toActivityError(error: unknown, fallback: ActivityErrorCode): ActivityError {
  if (isActivityError(error)) return error;
  const message = error instanceof Error ? error.message : 'Unknown error';
  return new ActivityError(fallback, message, { cause: error });
}
