import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FromWorker, MapVideoEncodeRequest } from '../../overlay/export/protocol';

/** The file the worker is given, and the encoder, stood in for: what matters is what is let go. */
const archive = { storage: 'opfs' as const, writeAt: vi.fn(), sink: { write: vi.fn() }, finish: vi.fn(), abort: vi.fn(async () => undefined) };
vi.mock('../../overlay/export/archiveSink', () => ({ createArchiveSink: async () => archive }));
const outputStart = vi.fn(async () => undefined);
const outputCancel = vi.fn(async () => undefined);
vi.mock('mediabunny', () => ({
  AudioSample: class {},
  AudioSampleSource: class {},
  BufferTarget: class {},
  Mp4OutputFormat: class {},
  WebMOutputFormat: class {},
  StreamTarget: class {},
  VideoSample: class {},
  VideoSampleSource: class {},
  Output: class {
    addVideoTrack() {}
    start = outputStart;
    cancel = outputCancel;
  },
  canEncodeAudio: async () => false,
}));

const { handleMapVideo } = await import('./encodeWorker');
const request: MapVideoEncodeRequest = { width: 640, height: 360, fps: 30, bitrate: 1_000_000, format: 'mp4', allowMemory: true, archiveName: 'overlay-export-m.zip' };

beforeEach(() => vi.clearAllMocks());

describe('the map video worker while it starts (AV-1209)', () => {
  // First: a session left over from a start that went on would answer for it.
  it('lets the file go when start-up fails after it was created', async () => {
    outputStart.mockRejectedValueOnce(new Error('no encoder'));
    const posted: FromWorker[] = [];
    await handleMapVideo({ type: 'mapVideoStart', request }, new AbortController(), (message) => void posted.push(message));
    expect(posted).toEqual([expect.objectContaining({ type: 'error', message: 'no encoder' })]);
    expect(archive.abort).toHaveBeenCalled();
    expect(outputCancel).toHaveBeenCalled();
  });

  it('answers a stop that came during start-up, and lets the file go', async () => {
    const posted: FromWorker[] = [];
    const controller = new AbortController();
    controller.abort();
    await handleMapVideo({ type: 'mapVideoStart', request }, controller, (message) => void posted.push(message));
    expect(posted).toEqual([expect.objectContaining({ type: 'error', code: 'cancelled' })]);
    expect(archive.abort).toHaveBeenCalled();
  });
});
