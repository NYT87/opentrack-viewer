import type { ActivitySourceFormat } from '../domain/activity';
import { ActivityError } from '../domain/errors';

export interface FormatDetection {
  format: ActivitySourceFormat;
  /** How the format was determined, for diagnostics and tests. */
  via: 'extension' | 'xml-root' | 'signature';
}

/** Bytes read from the head of the file for signature sniffing. */
const SIGNATURE_BYTES = 512;

/**
 * AV-902. How much of a video's tail to sniff for GoPro's markers.
 *
 * A camera writes `moov` — and with it the `gpmd` track and GoPro's `udta`
 * atoms — at the *end* of the file, so the head cannot answer the question. 64
 * KiB of a multi-gigabyte recording is still the minimum needed to identify it,
 * and it is read only once the head has already said this is a video.
 */
const VIDEO_TAIL_BYTES = 64 * 1024;

const EXTENSION_FORMATS: Record<string, ActivitySourceFormat> = {
  gpx: 'gpx',
  fit: 'fit',
  tcx: 'tcx',
  kml: 'kml',
  geojson: 'geojson',
  json: 'geojson',
  csv: 'csv',
  mp4: 'video',
  mov: 'video',
};

/**
 * Formats the generic file intake accepts.
 *
 * `gopro` is deliberately absent even though `extractGpmf` and `parseGopro`
 * can read one: `AV-907` gives video its own route, because pulling telemetry
 * out of a multi-gigabyte file needs progress and cancellation that the plain
 * drop zone has nowhere to put. Adding it here would build the thing that task
 * exists to avoid.
 */
export const SUPPORTED_FORMATS: ActivitySourceFormat[] = ['gpx', 'fit', 'tcx'];

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * AV-103. Async by contract so binary signature checks (FIT header at byte 8,
 * `.FIT`) can be added without changing every caller.
 */
export async function detectFormat(file: File): Promise<FormatDetection> {
  const head = await readHead(file);

  // FIT: byte 8..11 spell ".FIT" in the file header. Checked before extension
  // so a mislabelled file is still routed to the right parser.
  if (isFitSignature(head)) return { format: 'fit', via: 'signature' };

  // AV-902. An ISO base media container announces itself in its first box, so
  // a video is identified from the head alone. Only then is its tail read, to
  // ask the more expensive question of whether it carries telemetry.
  if (isIsoBaseMediaSignature(head)) {
    const gopro = (await hasGoProMarkers(file, head)) ? 'gopro' : 'video';
    return { format: gopro, via: 'signature' };
  }

  const xmlRoot = detectXmlRoot(head);
  if (xmlRoot) return { format: xmlRoot, via: 'xml-root' };

  const byExtension = EXTENSION_FORMATS[extensionOf(file.name)];
  if (byExtension) return { format: byExtension, via: 'extension' };

  throw new ActivityError(
    'unsupported_format',
    `"${file.name}" is not a recognized activity file.`,
  );
}

/** Detects and rejects formats that are recognized but not yet parseable. */
export async function detectSupportedFormat(file: File): Promise<FormatDetection> {
  const detection = await detectFormat(file);
  if (!SUPPORTED_FORMATS.includes(detection.format)) {
    throw new ActivityError('unsupported_format', unsupportedMessage(detection.format));
  }
  return detection;
}

/**
 * AV-902. A video is turned away for a different reason than a spreadsheet is,
 * and saying which is the difference between a clear refusal and a shrug.
 */
function unsupportedMessage(format: ActivitySourceFormat): string {
  if (format === 'gopro') {
    return 'This looks like a GoPro video with telemetry, but reading it is not available yet.';
  }
  if (format === 'video') {
    return 'This is a video file. Only GoPro videos carry the telemetry this app can read, and ' +
      'support for them is not available yet.';
  }
  return (
    `${format.toUpperCase()} files are not supported yet. This build reads GPX, FIT and TCX.`
  );
}

async function readHead(file: File): Promise<Uint8Array> {
  const slice = file.slice(0, SIGNATURE_BYTES);
  return new Uint8Array(await slice.arrayBuffer());
}

function isFitSignature(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  return (
    head[8] === 0x2e && head[9] === 0x46 && head[10] === 0x49 && head[11] === 0x54 // ".FIT"
  );
}

/**
 * An ISO base media file (MP4, MOV) opens with a box whose type is `ftyp`,
 * four bytes in — after the box's own length.
 */
function isIsoBaseMediaSignature(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  return (
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70 // "ftyp"
  );
}

/**
 * AV-902. Whether a video looks like it carries GoPro telemetry.
 *
 * `gpmd` is the handler and codec name of the metadata track; `GoPro`, `GPRO`,
 * `HERO`, `FIRM`, `GPS5` and `GPS9` appear in camera atoms or the GPMF stream
 * itself, depending on model and where `moov` was written. Any of them is
 * enough to route the file hopefully — `AV-903` is what decides definitively,
 * by actually finding the track.
 *
 * Deliberately "when possible", as the task puts it: a `moov` too far from
 * either end goes unrecognized and the file is treated as ordinary video,
 * which is the honest answer rather than a guess.
 */
async function hasGoProMarkers(file: File, head: Uint8Array): Promise<boolean> {
  if (containsGoProMarker(head)) return true;

  const tailStart = Math.max(SIGNATURE_BYTES, file.size - VIDEO_TAIL_BYTES);
  if (tailStart >= file.size) return false;

  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  return containsGoProMarker(tail);
}

function containsGoProMarker(bytes: Uint8Array): boolean {
  // latin1 so arbitrary binary decodes without loss or replacement characters.
  const text = new TextDecoder('latin1').decode(bytes);
  return /gpmd|GoPro|GPRO|HERO|FIRM|GPS[59]/.test(text);
}

function detectXmlRoot(head: Uint8Array): ActivitySourceFormat | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).toLowerCase();
  if (!text.includes('<')) return undefined;
  if (text.includes('<gpx')) return 'gpx';
  if (text.includes('<trainingcenterdatabase')) return 'tcx';
  if (text.includes('<kml')) return 'kml';
  return undefined;
}
