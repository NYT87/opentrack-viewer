import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { assertUsableActivity } from '../domain/validation';
import { detectSupportedFormat, type FormatDetection } from './detectFormat';
import { parseGpx } from './gpx/parseGpx';

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
  // fit: added by AV-702.
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
    throw toActivityError(error, detection.format === 'fit' ? 'fit_parse_failed' : 'invalid_gpx_xml');
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
