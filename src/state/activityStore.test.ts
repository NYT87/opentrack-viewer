import { afterEach, describe, expect, it, vi } from 'vitest';
import { useActivityStore } from './activityStore';
import { parseActivityFile } from '../parsers';
import { makeActivity } from '../test/helpers/activity';

vi.mock('../parsers', () => ({ parseActivityFile: vi.fn() }));
const parse = vi.mocked(parseActivityFile);
const file = new File([''], 'ride.gpx');
const activity = (name: string) => ({ ...makeActivity([{ lat: 40, lon: -3 }]), id: name });

function deferredRead() {
  let resolve!: (value: Awaited<ReturnType<typeof parseActivityFile>>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Awaited<ReturnType<typeof parseActivityFile>>>((yes, no) => { resolve = yes; reject = no; });
  parse.mockReturnValueOnce(promise);
  return { finish: (id: string) => resolve({ activity: activity(id), detection: { format: 'gpx', via: 'extension' } }), reject };
}

afterEach(() => { useActivityStore.getState().clear(); vi.resetAllMocks(); });

describe('asynchronous activity ownership', () => {
  it('keeps the later file when earlier parsing finishes last', async () => {
    const old = deferredRead();
    const first = useActivityStore.getState().loadFile(file);
    const latest = deferredRead();
    const second = useActivityStore.getState().loadFile(file);
    latest.finish('latest'); await second;
    old.finish('old'); await first;
    expect(useActivityStore.getState().activity?.id).toBe('latest');
  });

  it('keeps a closed activity closed when its replacement finishes', async () => {
    useActivityStore.getState().setActivity(activity('open'));
    const pending = deferredRead();
    const replacement = useActivityStore.getState().replaceFile(file);
    useActivityStore.getState().clear();
    pending.finish('late'); await replacement;
    expect(useActivityStore.getState().status).toBe('empty');
    expect(useActivityStore.getState().activity).toBeUndefined();
  });

  it('does not let a stale failure or progress replace a handoff', async () => {
    const pending = deferredRead();
    const loading = useActivityStore.getState().loadFile(file);
    const progress = parse.mock.calls[0]?.[1]?.onPhase;
    useActivityStore.getState().setActivity(activity('handoff'));
    progress?.('processing');
    pending.reject(new Error('stale failure')); await loading;
    expect(useActivityStore.getState()).toMatchObject({ status: 'ready', activity: { id: 'handoff' }, error: undefined });
  });
});
