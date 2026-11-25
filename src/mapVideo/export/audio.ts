/**
 * AV-1209. The reader's own sound for a map video: decoded in the page,
 * trimmed to the video's length, and faded out where it is cut. No music is
 * bundled or fetched; the file never leaves the tab (TD-072).
 */

/** Sound as the encoder takes it: one array of samples per channel. */
export interface MapVideoAudio {
  sampleRate: number;
  channels: Float32Array[];
  /** Seconds of sound kept. */
  seconds: number;
  /** Whether the sound was longer than the video, and so cut and faded. */
  trimmed: boolean;
}

/** How long the sound takes to fade out when it is cut at the video's end. */
export const AUDIO_FADE_SECONDS = 2;

/**
 * The sound fitted to the video: cut at its length and faded out over the
 * last `AUDIO_FADE_SECONDS` (or the whole, if shorter) when it runs on; left
 * as it is, ending early, when it is shorter. At most two channels are kept.
 */
export function fitAudio(channels: Float32Array[], sampleRate: number, videoSeconds: number): MapVideoAudio {
  const kept = channels.slice(0, 2);
  const length = kept[0]?.length ?? 0;
  const limit = Math.round(videoSeconds * sampleRate);
  if (length <= limit) return { sampleRate, channels: kept.map((channel) => channel.slice()), seconds: length / sampleRate, trimmed: false };
  const fade = Math.min(limit, Math.round(AUDIO_FADE_SECONDS * sampleRate));
  const out = kept.map((channel) => {
    const cut = channel.slice(0, limit);
    for (let i = 0; i < fade; i += 1) cut[limit - fade + i]! *= 1 - (i + 1) / fade;
    return cut;
  });
  return { sampleRate, channels: out, seconds: limit / sampleRate, trimmed: true };
}

/** Decodes an audio file with the browser's own decoders, or says why it cannot. */
export async function decodeAudioFile(file: File): Promise<{ channels: Float32Array[]; sampleRate: number } | { problem: string }> {
  const Context = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return { problem: 'This browser cannot decode sound here.' };
  const context = new Context();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    return { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)) };
  } catch {
    return { problem: `${file.name} could not be decoded as sound: it may be damaged, or in a format this browser does not read.` };
  } finally {
    void context.close();
  }
}
