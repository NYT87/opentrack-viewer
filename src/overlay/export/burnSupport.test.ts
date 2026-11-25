import { describe, expect, it } from 'vitest';
import { codecName, describeBurnReadiness, getBurnSupport, isLikelyMobile, type BurnReadinessInput } from './burnSupport';

const env = (overrides: Record<string, unknown> = {}, navigator: Record<string, unknown> = {}) =>
  ({
    Worker: function () {},
    OffscreenCanvas: function () {},
    VideoEncoder: function () {},
    VideoDecoder: function () {},
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150', maxTouchPoints: 0, ...navigator },
    ...overrides,
  }) as unknown as typeof globalThis;

describe('burned-in export support (AV-1007)', () => {
  it('is supported on a desktop browser with workers, offscreen canvas and WebCodecs', () => {
    expect(getBurnSupport(env())).toEqual({ supported: true });
  });

  it('says what is missing, by capability, and points to the overlay-only export', () => {
    const noWorker = getBurnSupport(env({ Worker: undefined }));
    expect(noWorker).toMatchObject({ supported: false });
    expect(noWorker.reason).toMatch(/in the background/);
    const noCodecs = getBurnSupport(env({ VideoEncoder: undefined }));
    expect(noCodecs.reason).toMatch(/WebCodecs/);
    expect(getBurnSupport(env({ VideoDecoder: undefined })).supported).toBe(false);
    for (const reason of [noWorker.reason, noCodecs.reason]) expect(reason).toMatch(/overlay-only export still works/);
  });

  describe('phones and tablets', () => {
    it.each([
      ['an iPhone', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' }],
      ['an Android phone', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/150 Mobile Safari/537.36' }],
      ['an iPad that calls itself a Mac', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 }],
      ['a browser that reports itself mobile', { userAgentData: { mobile: true } }],
    ])('declares %s desktop-only', (_name, navigator) => {
      const support = getBurnSupport(env({}, navigator));
      expect(support.supported).toBe(false);
      expect(support.reason).toMatch(/desktop browsers only/);
      expect(support.reason).toMatch(/overlay-only export still works/);
    });

    it('does not mistake a touch-screen laptop for a tablet', () => {
      expect(isLikelyMobile(env({}, { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150', maxTouchPoints: 10 }))).toBe(false);
    });
  });
});

const ok: BurnReadinessInput = {
  info: {
    video: { codec: 'avc', width: 1920, height: 1080, canDecode: true },
    audio: { codec: 'aac', canDecode: true },
    canEncode: true,
  },
  tooLarge: false,
  estimatedBytes: 500_000_000,
  freeBytes: 50_000_000_000,
  fileStorage: true,
};

describe('can this video be rendered here (AV-1007)', () => {
  it('has nothing to say against a decodable video that can be encoded here and has room', () => {
    expect(describeBurnReadiness(ok).errors).toEqual([]);
  });

  it('refuses a video this browser cannot decode, naming its format and size', () => {
    const { errors } = describeBurnReadiness({
      ...ok,
      info: { ...ok.info, video: { codec: 'hevc', width: 3840, height: 2160, canDecode: false } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cannot decode this video \(HEVC \(H\.265\), 3840 × 2160\)/);
    expect(errors[0]).toMatch(/overlay-only export still works/);
  });

  it('refuses a file with no picture', () => {
    const { errors } = describeBurnReadiness({ ...ok, info: { ...ok.info, video: undefined } });
    expect(errors[0]).toMatch(/no video picture/);
  });

  it('refuses where H.264 cannot be encoded at this size, without claiming anything about hardware', () => {
    const { errors } = describeBurnReadiness({ ...ok, info: { ...ok.info, canEncode: false } });
    expect(errors[0]).toMatch(/cannot encode H\.264 video at this size/);
    expect(errors[0]).not.toMatch(/hardware/i);
  });

  it('says the time assumes a hardware encoder that the browser is asked for but cannot confirm', () => {
    const { notes } = describeBurnReadiness(ok);
    expect(notes[0]).toMatch(/assumes this browser uses a hardware video encoder/);
    expect(notes[0]).toMatch(/asked for but cannot confirm/);
    expect(notes[0]).toMatch(/slower, possibly much slower/);
  });

  it('refuses a picture beyond 4K', () => {
    expect(describeBurnReadiness({ ...ok, tooLarge: true }).errors[0]).toMatch(/larger than this export can handle/);
  });

  it('refuses where the output cannot go to a file, since a video does not fit in memory', () => {
    expect(describeBurnReadiness({ ...ok, fileStorage: false }).errors[0]).toMatch(/too big to hold in memory/);
  });

  it('refuses when the device does not have the room, saying how much is needed and free', () => {
    const { errors } = describeBurnReadiness({ ...ok, estimatedBytes: 4_000_000_000, freeBytes: 3_000_000_000 });
    expect(errors[0]).toMatch(/needs about 4\.0 GB and the browser reports 3\.0 GB free/);
    // An unknown amount of space is not a reason to refuse.
    expect(describeBurnReadiness({ ...ok, estimatedBytes: 4_000_000_000, freeBytes: undefined }).errors).toEqual([]);
  });

  it('reports every reason at once', () => {
    const { errors } = describeBurnReadiness({
      ...ok,
      tooLarge: true,
      fileStorage: false,
      info: { ...ok.info, canEncode: false },
    });
    expect(errors).toHaveLength(3);
  });

  describe('the sound (decided in TD-039: copied through unchanged)', () => {
    it('says AAC is copied unchanged', () => {
      expect(describeBurnReadiness(ok).notes).toContain('The sound is copied from your video unchanged.');
    });
    it('says what may happen to anything else, without promising a codec the render does not choose', () => {
      const { notes } = describeBurnReadiness({ ...ok, info: { ...ok.info, audio: { codec: 'pcm-s16', canDecode: true } } });
      const sound = notes.find((note) => note.startsWith('The sound'))!;
      expect(sound).toMatch(/PCM-S16\) is copied unchanged if an MP4 can hold it as it is/);
      expect(sound).toMatch(/If not, it is converted where this browser can, and left out where it cannot/);
      expect(sound).not.toMatch(/AAC/);
    });
    it('says when there is none', () => {
      expect(describeBurnReadiness({ ...ok, info: { ...ok.info, audio: undefined } }).notes).toContain('This video has no sound.');
    });
  });

  it('names codecs plainly', () => {
    expect(codecName('avc')).toBe('H.264');
    expect(codecName('vp9')).toBe('VP9');
    expect(codecName(null)).toBe('an unknown format');
  });
});
