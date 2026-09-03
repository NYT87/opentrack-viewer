import type { ActivitySourceFormat } from '../domain/activity';
import { ActivityError } from '../domain/errors';

export interface FormatDetection {
  format: ActivitySourceFormat;
  /** How the format was determined, for diagnostics and tests. */
  via: 'extension' | 'xml-root' | 'signature';
}

/** Bytes read from the head of the file for signature sniffing. */
const SIGNATURE_BYTES = 512;

const EXTENSION_FORMATS: Record<string, ActivitySourceFormat> = {
  gpx: 'gpx',
  fit: 'fit',
  tcx: 'tcx',
  kml: 'kml',
  geojson: 'geojson',
  json: 'geojson',
  csv: 'csv',
};

/** Formats this build can actually parse. Grows with AV-702 and Epic E6. */
export const SUPPORTED_FORMATS: ActivitySourceFormat[] = ['gpx'];

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
    throw new ActivityError(
      'unsupported_format',
      `${detection.format.toUpperCase()} files are not supported yet. This build reads GPX.`,
    );
  }
  return detection;
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

function detectXmlRoot(head: Uint8Array): ActivitySourceFormat | undefined {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).toLowerCase();
  if (!text.includes('<')) return undefined;
  if (text.includes('<gpx')) return 'gpx';
  if (text.includes('<trainingcenterdatabase')) return 'tcx';
  if (text.includes('<kml')) return 'kml';
  return undefined;
}
