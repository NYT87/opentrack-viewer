import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBurn } from './burnWorker';
import type { BurnRequest, FromWorker } from './protocol';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';

const activity = makeActivity([{ time: new Date(0) }, { time: new Date(1000) }]);

const request: BurnRequest = {
  file: new File(['video'], 'a.mp4'),
  width: 640,
  height: 360,
  bitrate: 1_000_000,
  videoDurationSeconds: 1,
  offsetSeconds: 0,
  units: 'metric',
  template: buildOverlay(DEFAULT_OVERLAY_CONTROLS, buildOverlayTimeline(activity)).template,
  activity,
  archiveName: 'overlay-export-w.zip',
};

afterEach(() => vi.unstubAllGlobals());

describe('the burned-in render in the worker (AV-1007)', () => {
  it('refuses to render into memory, and says why', async () => {
    // No origin-private file system here, so the sink has no positional write.
    const posted: FromWorker[] = [];
    await handleBurn(request, new AbortController(), (message) => posted.push(message));
    expect(posted).toEqual([
      {
        type: 'error',
        code: 'storage_failed',
        message: expect.stringMatching(/too big to hold in memory/),
      },
    ]);
  });
});
