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

export type ToWorker =
  | { type: 'start'; request: ExportRequest }
  | { type: 'cancel' }
  /** Asks which storage the worker can really write to, without exporting. */
  | { type: 'probe'; archiveName: string };

export type FromWorker =
  | { type: 'progress'; done: number; total: number }
  | { type: 'probed'; storage: ArchiveStorage }
  | {
      type: 'done';
      file: Blob;
      bytes: number;
      frameCount: number;
      storage: ArchiveStorage;
    }
  | { type: 'error'; code: OverlayExportErrorCode; message: string };

export const ARCHIVE_NAME_PREFIX = 'overlay-export-';
