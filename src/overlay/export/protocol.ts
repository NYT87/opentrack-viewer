import type { Activity } from '../../domain/activity';
import type { UnitSystem } from '../../domain/units';
import type { OverlayExportErrorCode } from './errors';
import type { OverlayTemplate } from '../template';

/** Everything the worker needs, structured-cloneable: data, never functions. */
export interface ExportRequest {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  videoDurationSeconds: number;
  /** The video's wall-clock start, where the container states one. */
  videoStart?: Date;
  offsetSeconds: number;
  units: UnitSystem;
  template: OverlayTemplate;
  activity: Activity;
  /**
   * Chosen by the page, so the page can delete the file even if the worker is
   * stopped mid-write and never reports it.
   */
  archiveName: string;
}

export type ArchiveStorage = 'opfs' | 'memory';

/**
 * AV-1007. Everything needed to render the video with the overlay burned in.
 * The `File` is the reader's own: the worker reads slices of it and never
 * copies it whole, and it is never sent anywhere.
 */
export interface BurnRequest {
  file: File;
  width: number;
  height: number;
  /** Target video bitrate, bits per second. */
  bitrate: number;
  frameRate?: number;
  videoDurationSeconds: number;
  videoStart?: Date;
  offsetSeconds: number;
  units: UnitSystem;
  template: OverlayTemplate;
  activity: Activity;
  archiveName: string;
}

/** What the worker found in a video, before anything is rendered. */
export interface BurnSourceInfo {
  video?: {
    /** Mediabunny's codec name: `avc`, `hevc`, `vp9`, `av1`… */
    codec: string | null;
    width: number;
    height: number;
    canDecode: boolean;
  };
  audio?: { codec: string | null; canDecode: boolean };
  /**
   * Whether this browser reports it can encode H.264 at this size, with hardware
   * asked for. A browser cannot say which encoder it will use, so this is
   * support, not proof of a hardware encoder.
   */
  canEncode: boolean;
}

export type ToWorker =
  | { type: 'start'; request: ExportRequest }
  | { type: 'cancel' }
  /** Asks which storage the worker can really write to, without exporting. */
  | { type: 'probe'; archiveName: string }
  /** AV-1007 */
  | { type: 'inspect'; file: File; width: number; height: number; bitrate: number; frameRate?: number }
  | { type: 'burn'; request: BurnRequest };

export type FromWorker =
  | { type: 'progress'; done: number; total: number }
  | { type: 'probed'; storage: ArchiveStorage }
  | { type: 'inspected'; info: BurnSourceInfo }
  /** A burned-in render's progress, 0 to 1, and how much of the video is done. */
  | { type: 'burnProgress'; fraction: number; processedSeconds: number }
  | {
      type: 'done';
      file: Blob;
      bytes: number;
      frameCount: number;
      storage: ArchiveStorage;
      /** Things the reader should know, such as audio that could not be carried over. */
      notes?: string[];
    }
  | { type: 'error'; code: OverlayExportErrorCode; message: string };

export const ARCHIVE_NAME_PREFIX = 'overlay-export-';
