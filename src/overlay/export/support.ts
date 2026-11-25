export interface ExportSupport {
  supported: boolean;
  /** Said to the reader when `supported` is false. */
  reason?: string;
}

/**
 * AV-1006. Whether this browser can run the export at all: a worker, and an
 * `OffscreenCanvas` that can encode a PNG. Asked by capability, never by
 * browser name (TD-039) — a browser that gains them is supported the day it
 * does.
 */
export function getExportSupport(env: typeof globalThis = globalThis): ExportSupport {
  if (typeof env.Worker !== 'function') {
    return {
      supported: false,
      reason: 'This browser cannot run background tasks, which the export needs.',
    };
  }
  const offscreen = (env as { OffscreenCanvas?: unknown }).OffscreenCanvas as
    | { prototype?: { convertToBlob?: unknown } }
    | undefined;
  if (
    typeof offscreen !== 'function' ||
    typeof (offscreen as { prototype?: { convertToBlob?: unknown } }).prototype?.convertToBlob !==
      'function'
  ) {
    return {
      supported: false,
      reason:
        'This browser cannot draw and encode images in the background, which the export needs. Try a current version of Chrome, Edge, Firefox or Safari.',
    };
  }
  return { supported: true };
}
