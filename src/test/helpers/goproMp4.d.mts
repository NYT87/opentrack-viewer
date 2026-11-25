export interface GoproMp4Layout {
  /** `ftyp`, the `mdat` header and the telemetry samples: everything before the filler. */
  head: Uint8Array;
  /** Zero bytes that stand in for the picture, between `head` and `tail`. */
  fillerBytes: number;
  /** The `moov`, which a camera writes last. */
  tail: Uint8Array;
  sampleCount: number;
}
export interface GoproMp4Options {
  payload: Uint8Array;
  fillerBytes?: number;
  gapBytes?: number;
  sampleDurationMs?: number;
  videoFrames?: number;
  createdAt?: Date;
  /** AV-1026. A `tmcd` track: the counter at the first frame, its rate and flags. */
  timecode?: {
    counter: number;
    timescale: number;
    frameDuration: number;
    framesPerSecond: number;
    flags?: number;
  };
  /** AV-1026. Leave the `gpmd` track out. */
  omitTelemetryTrack?: boolean;
}
export function layoutGoproMp4(options: GoproMp4Options): GoproMp4Layout;
export function buildGoproMp4(options: GoproMp4Options): Uint8Array;
export function splitDevcChunks(payload: Uint8Array): Uint8Array[];
export function box(type: string, ...payloads: Uint8Array[]): Uint8Array;
export function concat(parts: Uint8Array[]): Uint8Array;
