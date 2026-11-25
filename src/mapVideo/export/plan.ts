import type { Activity } from '../../domain/activity';
import type { MapVideoModel } from '../model';
import { outputProblem, type MapVideoSettings } from '../project';

/**
 * AV-1209. What an export will be, before a frame is drawn: how many frames,
 * at what size and rate, in which container and codec, how large, and what
 * the file is called. Pure, so the panel can say all of it first (TD-072).
 */

export type MapVideoFormat = 'mp4' | 'webm';

export interface MapVideoExportPlan {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  lengthSeconds: number;
  format: MapVideoFormat;
  /** Mediabunny's codec name: H.264 in MP4, VP9 in WebM. */
  codec: 'avc' | 'vp9';
  /** Bits per second, from the picture's area and rate: about 10 Mbit/s at 1080p30 (TD-064). */
  bitrate: number;
  /** Roughly how large the file will be, in bytes, before any sound. */
  estimatedBytes: number;
  fileName: string;
}

/** Bits a pixel gets each second: 1920 × 1080 × 30 × 0.16 is about 10 Mbit/s, TD-064's figure. */
const BITS_PER_PIXEL_SECOND = 0.16;

/** A file name's base for an activity: its file's own name without the extension, made safe, or its name, or "activity". */
export function activityBaseName(activity: Activity): string {
  const raw = activity.source.fileName?.replace(/\.[^.]+$/, '') ?? activity.metadata.name ?? 'activity';
  const safe = raw
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return safe || 'activity';
}

export function planMapVideoExport(
  activity: Activity,
  model: MapVideoModel,
  settings: MapVideoSettings,
  format: MapVideoFormat,
): MapVideoExportPlan | { problem: string } {
  const problem = outputProblem(settings);
  if (problem) return { problem };
  const { width, height, fps } = settings.output;
  const bitrate = Math.round(width * height * fps * BITS_PER_PIXEL_SECOND);
  return {
    width,
    height,
    fps,
    frameCount: model.frameCount,
    lengthSeconds: settings.lengthSeconds,
    format,
    codec: format === 'mp4' ? 'avc' : 'vp9',
    bitrate,
    estimatedBytes: Math.round((bitrate * settings.lengthSeconds) / 8),
    fileName: `${activityBaseName(activity)}-map-video-${width}x${height}.${format}`,
  };
}

/** The poster's name: the video's, and the moment it was taken from. */
export function posterFileName(activity: Activity, seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 10)) / 10;
  const minutes = Math.floor(total / 60);
  const rest = (total - minutes * 60).toFixed(1).replace('.', '_');
  return `${activityBaseName(activity)}-map-video-poster-${minutes}m${rest}s.png`;
}
