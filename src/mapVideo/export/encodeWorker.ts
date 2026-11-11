import type * as Mediabunny from 'mediabunny';
import { createArchiveSink, type ArchiveSink } from '../../overlay/export/archiveSink';
import { OverlayExportError, isOverlayExportError } from '../../overlay/export/errors';
import type { FromWorker, MapVideoEncodeRequest, ToWorker } from '../../overlay/export/protocol';

/**
 * AV-1209. The worker's side of a map video: frames arrive one by one from
 * the page, already drawn; each is encoded (H.264 in MP4, or VP9 in WebM)
 * and written to a file in the origin-private file system, never held in
 * memory (TD-045, TD-072). The reader's sound, if any, is encoded with them.
 */
type Post = (message: FromWorker) => void;
type MapVideoMessage = Extract<ToWorker, { type: 'mapVideoStart' | 'mapVideoFrame' | 'mapVideoFinish' }>;

interface Session {
  archive: ArchiveSink;
  /** The video built in memory, where no file could be written. */
  memory?: Mediabunny.BufferTarget;
  mimeType: string;
  output: Mediabunny.Output;
  video: Mediabunny.VideoSampleSource;
  mb: Pick<typeof Mediabunny, 'VideoSample'>;
  /** Frames are encoded in the order they came, one after another. */
  queue: Promise<void>;
  frames: number;
  notes: string[];
  failed: boolean;
}

let session: Session | undefined;

const loadMediabunny = async () => {
  const { AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, Output, StreamTarget, VideoSample, VideoSampleSource, WebMOutputFormat, canEncodeAudio } = await import('mediabunny');
  return { AudioSample, AudioSampleSource, BufferTarget, Mp4OutputFormat, Output, StreamTarget, VideoSample, VideoSampleSource, WebMOutputFormat, canEncodeAudio };
};

function fail(error: unknown, post: Post): void {
  const current = session;
  session = undefined;
  if (current) {
    current.failed = true;
    void current.output.cancel().catch(() => undefined);
    void current.archive.abort();
  }
  if (isOverlayExportError(error)) post({ type: 'error', code: error.code, message: error.message });
  else post({ type: 'error', code: 'render_failed', message: error instanceof Error ? error.message : 'The video could not be encoded.' });
}

async function start(request: MapVideoEncodeRequest, controller: AbortController, post: Post): Promise<void> {
  const archive = await createArchiveSink(request.archiveName);
  // An MP4 goes back to patch its header: it is written to a file. Where no file can be had (a
  // private window), a video small enough is built in memory; a larger one is refused.
  if (!archive.writeAt && !request.allowMemory) {
    await archive.abort();
    throw new OverlayExportError(
      'storage_failed',
      'This video is too big to build in memory, and this browser will not give the page a file to write it to (a private window does not). Make it shorter or smaller, or use a normal window.',
    );
  }
  const writeAt = archive.writeAt;
  const mb = await loadMediabunny();
  const mp4 = request.format === 'mp4';
  const memory = writeAt ? undefined : new mb.BufferTarget();
  const output = new mb.Output({
    format: mp4 ? new mb.Mp4OutputFormat({ fastStart: writeAt ? false : 'in-memory' }) : new mb.WebMOutputFormat(),
    target:
      memory ??
      new mb.StreamTarget(
        new WritableStream({
          write(chunk: Mediabunny.StreamTargetChunk) {
            writeAt!(chunk.data, chunk.position);
          },
        }),
      ),
  });
  const video = new mb.VideoSampleSource({
    codec: mp4 ? 'avc' : 'vp9',
    bitrate: request.bitrate,
    keyFrameInterval: 2,
    // Asked for, not promised: a browser cannot be made to say which encoder it uses (TD-045).
    hardwareAcceleration: mp4 ? 'prefer-hardware' : 'no-preference',
  });
  output.addVideoTrack(video, { frameRate: request.fps });

  const notes: string[] = [];
  let sound: Mediabunny.AudioSampleSource | undefined;
  if (request.audio) {
    const options = { numberOfChannels: request.audio.channels.length, sampleRate: request.audio.sampleRate, bitrate: 192_000 };
    const codec = mp4
      ? (await mb.canEncodeAudio('aac', options)) ? 'aac' : (await mb.canEncodeAudio('opus', options)) ? 'opus' : undefined
      : (await mb.canEncodeAudio('opus', options)) ? 'opus' : undefined;
    if (codec) {
      sound = new mb.AudioSampleSource({ codec, bitrate: 192_000 });
      output.addAudioTrack(sound);
    } else {
      notes.push('This browser cannot encode sound for this video, so it has none.');
    }
  }
  await output.start();
  if (sound && request.audio) {
    // A second at a time, as planar float samples.
    const { sampleRate, channels } = request.audio;
    const length = channels[0]?.length ?? 0;
    for (let from = 0; from < length && !controller.signal.aborted; from += sampleRate) {
      const to = Math.min(length, from + sampleRate);
      const data = new Float32Array((to - from) * channels.length);
      channels.forEach((channel, i) => data.set(channel.subarray(from, to), i * (to - from)));
      const sample = new mb.AudioSample({ data, format: 'f32-planar', numberOfChannels: channels.length, sampleRate, timestamp: from / sampleRate });
      await sound.add(sample);
      sample.close();
    }
    sound.close();
  }
  session = { archive, memory, mimeType: mp4 ? 'video/mp4' : 'video/webm', output, video, mb, queue: Promise.resolve(), frames: 0, notes, failed: false };
  controller.signal.addEventListener('abort', () => fail(new OverlayExportError('cancelled', 'The export was stopped.'), post), { once: true });
  post({ type: 'mapVideoReady' });
}

/** The worker's half of a map video export, one message at a time. */
export async function handleMapVideo(message: MapVideoMessage, controller: AbortController, post: Post): Promise<void> {
  try {
    if (message.type === 'mapVideoStart') {
      await start(message.request, controller, post);
      return;
    }
    const current = session;
    if (!current) {
      if (message.type === 'mapVideoFrame') message.frame.close();
      return;
    }
    if (message.type === 'mapVideoFrame') {
      const { frame, index } = message;
      current.queue = current.queue.then(async () => {
        if (current.failed) {
          frame.close();
          return;
        }
        const sample = new current.mb.VideoSample(frame);
        try {
          await current.video.add(sample);
        } finally {
          sample.close();
          frame.close();
        }
        current.frames += 1;
        post({ type: 'mapVideoFrameDone', index });
      });
      current.queue.catch((error: unknown) => fail(error, post));
      return;
    }
    await current.queue;
    if (current.failed) return;
    await current.output.finalize();
    let file: Blob;
    if (current.memory) {
      // Built in memory: the archive held nothing, and is let go.
      await current.archive.abort();
      file = new Blob([current.memory.buffer!], { type: current.mimeType });
    } else {
      file = await current.archive.finish();
    }
    session = undefined;
    post({ type: 'done', file, bytes: file.size, frameCount: current.frames, storage: current.memory ? 'memory' : current.archive.storage, notes: current.notes });
  } catch (error) {
    fail(error, post);
  }
}
