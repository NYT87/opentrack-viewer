import { describe, expect, it, vi } from 'vitest';
import { WEBM_MIME_TYPE, getWebmCapability, probeWebmSupport } from './webmSupport';

/** AV-1012. The quick check, by capability; the probe itself needs a browser and is covered there. */

const env = (overrides: Record<string, unknown>) => ({ ...overrides }) as unknown as typeof globalThis;
const recorder = (supported: boolean) => Object.assign(function MediaRecorder() {}, { isTypeSupported: vi.fn(() => supported) });
const canvas = { prototype: { captureStream: () => undefined } };

describe('whether a transparent WebM can be recorded (AV-1012)', () => {
  it('needs a recorder that writes VP9 WebM and a canvas it can record', () => {
    const yes = recorder(true);
    expect(getWebmCapability(env({ MediaRecorder: yes, HTMLCanvasElement: canvas }))).toEqual({ supported: true });
    expect(yes.isTypeSupported).toHaveBeenCalledWith(WEBM_MIME_TYPE);

    for (const missing of [
      env({ HTMLCanvasElement: canvas }),
      env({ MediaRecorder: recorder(true), HTMLCanvasElement: { prototype: {} } }),
      env({ MediaRecorder: recorder(false), HTMLCanvasElement: canvas }),
    ]) {
      expect(getWebmCapability(missing)).toMatchObject({ supported: false, reason: expect.stringMatching(/PNG sequence/) });
    }
  });

  it('answers at once, recording nothing, where the parts are missing', async () => {
    await expect(probeWebmSupport(env({}))).resolves.toMatchObject({ supported: false });
  });
});
