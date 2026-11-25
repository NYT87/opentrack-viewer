import { describe, expect, it } from 'vitest';
import { ActivityError } from '../domain/errors';
import { readZip } from '../test/helpers/zip';
import { computeStreams, type Activity, type ActivityPoint } from '../domain/activity';
import {
  FRAMES_PER_ARCHIVE,
  MAX_FRAMES,
  MAX_FRAME_SIZE,
  exportFrameSequence,
  planFrameExport,
  readmeText,
  type FrameArchive,
  type FrameExportOptions,
  type FrameSurface,
} from './exportFrames';
import { createOverlayRenderer, type OverlayContext2D, type OverlayRenderer } from './renderOverlay';
import { availabilityOf, compactHudTemplate } from './template';
import { buildTimeline } from './timeline';

const options = (over: Partial<FrameExportOptions> = {}): FrameExportOptions => ({
  fps: 30,
  width: 320,
  height: 180,
  startSeconds: 0,
  endSeconds: 4,
  offsetSeconds: 0,
  ...over,
});

/** A renderer that only records the times it was asked for. */
function recordingRenderer() {
  const calls: { w: number; h: number; t: number; offset: number }[] = [];
  const renderer: OverlayRenderer = {
    resolved: { components: [], hidden: [] },
    render: (_ctx, w, h, t, offset) => calls.push({ w, h, t, offset }),
  };
  return { renderer, calls };
}

/** A surface whose "PNG" is a few bytes naming the frame, so entries can be told apart. */
function fakeSurface(log?: string[]) {
  let n = 0;
  const surface: FrameSurface = {
    context: {} as OverlayContext2D,
    toPng: async () => {
      n += 1;
      log?.push(`encode ${n}`);
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, n & 255, (n >> 8) & 255]);
    },
  };
  return surface;
}

const run = async (over: Partial<Parameters<typeof exportFrameSequence>[0]> = {}) => {
  const archives: FrameArchive[] = [];
  const { renderer, calls } = recordingRenderer();
  const result = await exportFrameSequence({
    options: options(),
    renderer,
    baseName: 'ride',
    createSurface: () => fakeSurface(),
    onArchive: (a) => void archives.push(a),
    ...over,
  });
  return { result, archives, calls };
};

const failsWith = (fn: () => unknown, code: string, pattern: RegExp) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toBe(code);
    expect((error as ActivityError).message).toMatch(pattern);
    return;
  }
  throw new Error('expected a typed error');
};

describe('planning an export (AV-1006)', () => {
  it('counts the frames a range makes', () => {
    expect(planFrameExport(options())).toMatchObject({ frameCount: 120, durationSeconds: 4, minimumArchives: 1 });
    expect(planFrameExport(options({ fps: 24, endSeconds: 2.5 })).frameCount).toBe(60);
    // A partial last frame still counts: the end of the range is covered.
    expect(planFrameExport(options({ fps: 10, endSeconds: 0.25 })).frameCount).toBe(3);
  });

  it('says how many archives a long export needs at least', () => {
    expect(planFrameExport(options({ fps: 60, endSeconds: 100 })).minimumArchives).toBe(4);
  });

  it.each([
    ['a fractional frame rate', { fps: 29.97 }, 'invalid_selected_range', /frame rate/],
    ['zero frames per second', { fps: 0 }, 'invalid_selected_range', /frame rate/],
    ['an enormous frame rate', { fps: 1000 }, 'invalid_selected_range', /frame rate/],
    ['a fractional width', { width: 100.5 }, 'invalid_selected_range', /width/],
    ['a tiny height', { height: 4 }, 'invalid_selected_range', /height/],
    ['an oversize width', { width: MAX_FRAME_SIZE + 1 }, 'overlay_export_too_large', /width can be at most/],
    ['an empty range', { startSeconds: 2, endSeconds: 2 }, 'invalid_selected_range', /after its start/],
    ['a backwards range', { startSeconds: 3, endSeconds: 1 }, 'invalid_selected_range', /after its start/],
    ['a negative start', { startSeconds: -1 }, 'invalid_selected_range', /negative/],
    ['a NaN setting', { offsetSeconds: NaN }, 'invalid_selected_range', /must be a number/],
    ['too many frames', { fps: 60, endSeconds: 60 * 60 }, 'overlay_export_too_large', /most one export makes/],
  ] as [string, Partial<FrameExportOptions>, string, RegExp][])('rejects %s, saying which setting', (_name, over, code, message) => {
    failsWith(() => planFrameExport(options(over)), code, message);
  });

  it('allows the largest export it promises', () => {
    expect(planFrameExport(options({ fps: 30, endSeconds: MAX_FRAMES / 30 })).frameCount).toBe(MAX_FRAMES);
  });
});

describe('exporting frames (AV-1006)', () => {
  it('draws one frame per step, at the right video time, size and offset', async () => {
    const { calls } = await run({ options: options({ fps: 10, endSeconds: 1, startSeconds: 0.5, offsetSeconds: 2.5, width: 640, height: 360 }) });
    expect(calls.map((c) => c.t)).toEqual([0.5, 0.6, 0.7, 0.8, 0.9].map((t) => expect.closeTo(t, 9)));
    expect(calls.every((c) => c.w === 640 && c.h === 360 && c.offset === 2.5)).toBe(true);
  });

  it('puts every frame in a numbered file, with the instructions beside the first', async () => {
    const { archives, result } = await run({ options: options({ fps: 10, endSeconds: 1 }) });
    expect(result.frameCount).toBe(10);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.fileName).toBe('ride-frames-part-01.zip');
    const files = await readZip(archives[0]!.blob);
    expect(files.map((f) => f.name)).toEqual([
      'ride_000001.png',
      'README.txt',
      ...Array.from({ length: 9 }, (_, i) => `ride_${String(i + 2).padStart(6, '0')}.png`),
    ]);
    const readme = new TextDecoder().decode(files.find((f) => f.name === 'README.txt')!.data);
    expect(readme).toContain('10 fps');
    expect(readme).toContain('320 x 180');
    expect(readme).toContain('Frames:      10');
  });

  it('carries each frame exactly as the surface encoded it', async () => {
    const { archives } = await run({ options: options({ fps: 4, endSeconds: 1 }) });
    const frames = (await readZip(archives[0]!.blob)).filter((f) => f.name.endsWith('.png'));
    expect(frames.map((f) => [...f.data])).toEqual(
      [1, 2, 3, 4].map((n) => [0x89, 0x50, 0x4e, 0x47, n, 0]),
    );
  });

  it('splits a long sequence into archives and hands each over as soon as it is full', async () => {
    const order: string[] = [];
    const { renderer } = recordingRenderer();
    const timed: OverlayRenderer = {
      ...renderer,
      render: (_c, _w, _h, t) => order.push(`frame ${Math.round(t * 100)}`), // frame at index i
    };
    const total = FRAMES_PER_ARCHIVE * 2 + 10;
    const archives: FrameArchive[] = [];
    await exportFrameSequence({
      options: options({ fps: 100, endSeconds: total / 100 }),
      renderer: timed,
      baseName: 'long',
      createSurface: () => fakeSurface(),
      onArchive: (a) => {
        order.push(`archive ${a.index}`);
        archives.push(a);
      },
    });

    expect(archives.map((a) => [a.firstFrame, a.lastFrame])).toEqual([
      [1, 1500],
      [1501, 3000],
      [3001, 3010],
    ]);
    expect(archives.map((a) => a.fileName)).toEqual([
      'long-frames-part-01.zip',
      'long-frames-part-02.zip',
      'long-frames-part-03.zip',
    ]);
    // The first archive left before the second one's frames were drawn: memory
    // holds one archive, not the whole sequence.
    expect(order.indexOf('archive 1')).toBeLessThan(order.indexOf('frame 1500'));
    expect(order.indexOf('archive 2')).toBeLessThan(order.indexOf('frame 3000'));
    // Only the first has the instructions, and numbering continues across parts.
    expect((await readZip(archives[0]!.blob)).some((f) => f.name === 'README.txt')).toBe(true);
    const second = await readZip(archives[1]!.blob);
    expect(second.some((f) => f.name === 'README.txt')).toBe(false);
    expect(second[0]!.name).toBe('long_001501.png');
    expect((await readZip(archives[2]!.blob)).at(-1)!.name).toBe('long_003010.png');
  });

  it('waits for each archive to be saved before carrying on', async () => {
    const log: string[] = [];
    const { renderer } = recordingRenderer();
    await exportFrameSequence({
      options: options({ fps: 100, endSeconds: (FRAMES_PER_ARCHIVE + 2) / 100 }),
      renderer,
      baseName: 'b',
      createSurface: () => fakeSurface(log),
      onArchive: async () => {
        log.push('saving');
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push('saved');
      },
    });
    const saving = log.indexOf('saving');
    expect(log[saving + 1]).toBe('saved');
    // No frame was encoded between starting to save and finishing.
    expect(log.slice(saving, saving + 2)).toEqual(['saving', 'saved']);
  });

  it('reports progress, with an estimate once it has something to go on', async () => {
    const seen: { framesDone: number; remainingMs?: number }[] = [];
    let t = 0;
    await run({
      options: options({ fps: 10, endSeconds: 1 }),
      now: () => (t += 10),
      onProgress: (p) => seen.push(p),
    });
    expect(seen.map((p) => p.framesDone)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seen[0]!.remainingMs).toBeUndefined();
    expect(seen[4]!.remainingMs).toBeGreaterThan(0);
    expect(seen.at(-1)!.remainingMs).toBe(0);
    expect(seen.at(-1)).toMatchObject({ frameCount: 10, archivesDone: 1 });
  });

  describe('stopping', () => {
    it('stops when asked, keeps what was already handed over, and hands over nothing more', async () => {
      const controller = new AbortController();
      const archives: FrameArchive[] = [];
      const { renderer, calls } = recordingRenderer();
      const total = FRAMES_PER_ARCHIVE + 500;
      const result = exportFrameSequence({
        options: options({ fps: 100, endSeconds: total / 100 }),
        renderer,
        baseName: 'c',
        signal: controller.signal,
        createSurface: () => fakeSurface(),
        onArchive: (a) => void archives.push(a),
        onProgress: (p) => {
          if (p.framesDone === FRAMES_PER_ARCHIVE + 100) controller.abort();
        },
      });
      await expect(result).rejects.toMatchObject({ code: 'overlay_export_cancelled' });
      expect(archives).toHaveLength(1);
      expect(archives[0]!.lastFrame).toBe(FRAMES_PER_ARCHIVE);
      // It did not carry on to the end.
      expect(calls.length).toBeLessThan(total);
      expect(calls.length).toBeLessThanOrEqual(FRAMES_PER_ARCHIVE + 101);
    });

    it('does nothing at all when already stopped', async () => {
      const controller = new AbortController();
      controller.abort();
      let surfaces = 0;
      await expect(
        run({ signal: controller.signal, createSurface: () => { surfaces += 1; return fakeSurface(); } }),
      ).rejects.toMatchObject({ code: 'overlay_export_cancelled' });
      expect(surfaces).toBe(0);
    });
  });

  describe('failing clearly', () => {
    it('says the browser cannot draw when it gives no surface', async () => {
      await expect(run({ createSurface: () => undefined })).rejects.toMatchObject({
        code: 'overlay_export_unsupported',
      });
    });

    it('reports a frame that cannot be encoded, keeping the cause', async () => {
      const cause = new Error('out of memory');
      await expect(
        run({
          createSurface: () => ({ context: {} as OverlayContext2D, toPng: () => Promise.reject(cause) }),
        }),
      ).rejects.toMatchObject({ code: 'overlay_export_failed', cause });
    });

    it('reports a failure to save an archive', async () => {
      await expect(
        run({
          onArchive: () => {
            throw new Error('disk full');
          },
        }),
      ).rejects.toMatchObject({ code: 'overlay_export_failed' });
    });

    it('rejects unusable options before drawing anything', async () => {
      let surfaces = 0;
      await expect(
        run({ options: options({ fps: 0 }), createSurface: () => { surfaces += 1; return fakeSurface(); } }),
      ).rejects.toMatchObject({ code: 'invalid_selected_range' });
      expect(surfaces).toBe(0);
    });
  });

  it('makes the same frame the preview would show', async () => {
    const T0 = Date.UTC(2024, 0, 1, 10);
    const points: ActivityPoint[] = Array.from({ length: 20 }, (_, s) => ({
      index: s,
      time: new Date(T0 + s * 1000),
      lat: 42 + s * 4e-5,
      lon: -8,
      elevationMeters: 100 + s,
    }));
    const activity: Activity = {
      id: 'a',
      source: { format: 'gpx', parserVersion: 't' },
      metadata: {},
      points,
      streams: computeStreams(points),
      warnings: [],
    };
    const timeline = buildTimeline(activity);
    if (!timeline.ok) throw new Error();
    const renderer = createOverlayRenderer({
      activity,
      timeline: timeline.timeline,
      template: compactHudTemplate(),
      availability: availabilityOf(timeline.timeline),
    });

    /** A context that records the text drawn in each frame. */
    const recorder = () => {
      const frames: string[][] = [];
      let current: string[] = [];
      const context = new Proxy(
        {},
        {
          get: (_t, name) => {
            if (name === 'fillText') return (text: string) => current.push(text);
            if (name === 'measureText') return () => ({ width: 0 });
            if (name === 'clearRect') {
              return () => {
                current = [];
                frames.push(current);
              };
            }
            return () => undefined;
          },
          set: () => true,
        },
      ) as unknown as OverlayContext2D;
      return { context, frames };
    };

    // What the exporter draws...
    const exported = recorder();
    await exportFrameSequence({
      options: options({ fps: 4, endSeconds: 2, offsetSeconds: 1 }),
      renderer,
      baseName: 'p',
      createSurface: () => ({ context: exported.context, toPng: async () => new Uint8Array([1]) }),
      onArchive: () => undefined,
    });

    // ...against asking the renderer directly for the same moments, as the preview does.
    const direct = recorder();
    for (const t of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]) renderer.render(direct.context, 320, 180, t, 1);

    expect(exported.frames).toHaveLength(8);
    expect(exported.frames).toEqual(direct.frames);
    // And they are not all the same: the figures move with the video.
    expect(new Set(exported.frames.map((f) => f.join('|'))).size).toBeGreaterThan(4);
  });

  it('handles a very long sequence in bounded steps', async () => {
    const started = performance.now();
    let archives = 0;
    let maxHeld = 0;
    let held = 0;
    const { renderer } = recordingRenderer();
    await exportFrameSequence({
      options: options({ fps: 100, endSeconds: 100 }),
      renderer,
      baseName: 'v',
      createSurface: () => fakeSurface(),
      onArchive: () => {
        archives += 1;
        held = 1;
        maxHeld = Math.max(maxHeld, held);
        held = 0;
      },
    });
    expect(archives).toBe(Math.ceil(10_000 / FRAMES_PER_ARCHIVE));
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('writes instructions that carry what an editor needs', () => {
    const text = readmeText(options({ fps: 25, width: 1920, height: 1080, startSeconds: 12 }), 250);
    expect(text).toMatch(/25 fps/);
    expect(text).toMatch(/1920 x 1080/);
    expect(text).toMatch(/Duration:\s+10\.000 seconds/);
    expect(text).toMatch(/Starts at:\s+12 s/);
    expect(text).toMatch(/transparent/);
  });
});
