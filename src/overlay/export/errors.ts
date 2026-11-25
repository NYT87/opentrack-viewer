/**
 * AV-1006. Why an overlay export did not produce a file. A separate type from
 * `ActivityError`: these are about writing output, and the export panel words
 * each one for the reader.
 */
export type OverlayExportErrorCode =
  | 'cancelled'
  | 'unsupported_browser'
  | 'too_large'
  | 'storage_failed'
  | 'render_failed';

export class OverlayExportError extends Error {
  readonly code: OverlayExportErrorCode;

  constructor(code: OverlayExportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OverlayExportError';
    this.code = code;
  }
}

export function isOverlayExportError(error: unknown): error is OverlayExportError {
  return error instanceof OverlayExportError;
}
