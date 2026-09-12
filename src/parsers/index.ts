import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError, type ActivityErrorCode } from '../domain/errors';
import { assertUsableActivity } from '../domain/validation';
import { detectSupportedFormat, type FormatDetection } from './detectFormat';
import { parseGpx } from './gpx/parseGpx';
import { parseTcx } from './tcx/parseTcx';

export { detectFormat, detectSupportedFormat, SUPPORTED_FORMATS } from './detectFormat';
export type { FormatDetection } from './detectFormat';

/**
 * Parser registry. Every entry is async so a parser can move to a Web Worker
 * (plan §14) without touching callers.
 */
type ParserFn = (file: File, options: ParseActivityFileOptions) => Promise<Activity>;

const REGISTRY: Partial<Record<FormatDetection['format'], ParserFn>> = {
  gpx: async (file, options) => {
    const text = await readText(file);
    options.onPhase?.('processing');
    return parseGpx(text, { fileName: file.name, fileSizeBytes: file.size });
  },
  // AV-751. XML like GPX, so it needs no library and loads with the app.
  tcx: async (file, options) => {
    const text = await readText(file);
    options.onPhase?.('processing');
    return parseTcx(text, { fileName: file.name, fileSizeBytes: file.size });
  },
  // No `gopro` entry: video is read on its own route (`AV-907`), not through
  // the generic intake, because it needs progress and cancellation. See
  // `SUPPORTED_FORMATS`.
  // AV-702. Imported lazily so the FIT library — ~61 KB gzipped — stays off the
  // initial page load and out of the main bundle (TD-018). It is still
  // precached by the service worker afterwards, in the background, so that
  // opening a .fit file works offline; the same is true of the map chunk.
  fit: async (file, options) => {
    const { parseFit } = await import('./fit/parseFit');
    const buffer = await file.arrayBuffer();
    options.onPhase?.('processing');
    return parseFit(buffer, { fileName: file.name, fileSizeBytes: file.size });
  },
};

/** How a parser's own failure is reported when it throws something untyped. */
const PARSE_FAILURE: Partial<Record<FormatDetection['format'], ActivityErrorCode>> = {
  gpx: 'invalid_gpx_xml',
  fit: 'fit_parse_failed',
  tcx: 'invalid_tcx_xml',
};

/** Files above this size get a "slow parse" heads-up warning (plan §15). */
const LARGE_FILE_BYTES = 15 * 1024 * 1024;

export interface ParseFileResult {
  activity: Activity;
  detection: FormatDetection;
}

export type ParsePhase = 'reading' | 'processing';

export interface ParseActivityFileOptions {
  /** Reports which wait the user is currently in (AV-004). */
  onPhase?: (phase: ParsePhase) => void;
}

/**
 * Full intake pipeline (plan §7): detect → parse → validate. All of it runs in
 * the browser; nothing here performs a network request.
 */
export async function parseActivityFile(
  file: File,
  options: ParseActivityFileOptions = {},
): Promise<ParseFileResult> {
  options.onPhase?.('reading');
  const detection = await detectSupportedFormat(file);
  const parser = REGISTRY[detection.format];

  if (!parser) {
    throw new ActivityError(
      'unsupported_format',
      `No parser is registered for ${detection.format.toUpperCase()} files.`,
    );
  }

  let activity: Activity;
  try {
    activity = await parser(file, options);
  } catch (error) {
    throw toActivityError(error, PARSE_FAILURE[detection.format] ?? 'invalid_gpx_xml');
  }

  const validation = assertUsableActivity(activity);
  activity.warnings.push(...validation.warnings);

  if (file.size > LARGE_FILE_BYTES) {
    activity.warnings.push({
      code: 'large_file_slow_parse',
      message: 'This is a large file; interaction may be slower than usual.',
      severity: 'info',
    });
  }

  return { activity, detection };
}

async function readText(file: File): Promise<string> {
  try {
    return await file.text();
  } catch (error) {
    throw new ActivityError('file_read_failed', 'The file could not be read.', { cause: error });
  }
}
