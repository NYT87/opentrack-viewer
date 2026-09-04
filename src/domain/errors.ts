/**
 * Typed error categories (plan §15). Every user-facing failure maps to one of
 * these so the UI can explain what the user can do next.
 */
export type ActivityErrorCode =
  | 'unsupported_format'
  | 'invalid_gpx_xml'
  | 'no_route_points'
  | 'no_location_stream'
  | 'map_style_load_failed'
  | 'fit_parse_failed'
  | 'large_file_slow_parse'
  | 'invalid_selected_range'
  | 'file_read_failed';

const HINTS: Record<ActivityErrorCode, string> = {
  unsupported_format: 'Try a .gpx file. More formats are coming.',
  invalid_gpx_xml: 'The file could not be read as GPX XML. It may be truncated or corrupted.',
  no_route_points: 'The file parsed, but contained no track points to display.',
  no_location_stream: 'This activity has no GPS coordinates, so no route can be drawn.',
  map_style_load_failed: 'The basemap could not load. The route is still available.',
  fit_parse_failed: 'The FIT file could not be decoded.',
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
