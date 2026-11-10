import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_VIDEO_SETTINGS,
  MAP_VIDEO_PROJECT_KIND,
  isProjectFor,
  outputProblem,
  parseMapVideoProject,
  referenceActivity,
  serializeMapVideoProject,
  type MapVideoProject,
} from './project';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION } from '../overlay/template';

const activity = () => {
  const made = activityThrough(straightNorth(1000).map((point) => ({ ...point, elevation: 432.5 })));
  return { ...made, source: { ...made.source, fileName: 'home-loop.gpx' }, metadata: { name: 'Sunday loop' } };
};
const project = (): MapVideoProject => ({
  activity: referenceActivity(activity()),
  settings: {
    ...DEFAULT_MAP_VIDEO_SETTINGS,
    lengthSeconds: 45,
    timing: { mode: 'time', pauseBeatSeconds: 1 },
    camera: { zoom: 15, pitch: 30, bearing: 'north', smoothingMeters: 500 },
    privacyTrim: { startMeters: 250, endMeters: 400 },
  },
});
const reopen = (json: string) => {
  const parsed = parseMapVideoProject(json);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
};
const withSettings = (settings: Record<string, unknown>) =>
  JSON.stringify({ kind: MAP_VIDEO_PROJECT_KIND, version: 1, activity: { fileName: null, points: 2 }, settings });

describe('the map video project file (AV-1203)', () => {
  it('reopens as it was saved', () => {
    const saved = project();
    const { project: opened, warnings } = reopen(serializeMapVideoProject(saved));
    expect(opened).toEqual(saved);
    expect(warnings).toEqual([]);
  });

  it('keeps an overlay layout through a save', () => {
    const saved = project();
    saved.settings.overlay = {
      version: OVERLAY_TEMPLATE_VERSION,
      name: 'Figures',
      style: DEFAULT_OVERLAY_STYLE,
      components: [
        { id: 'text-1', type: 'label', visible: true, unitMode: 'metric', style: {}, rect: { x: 0.05, y: 0.05, width: 0.3, height: 0.08 }, content: 'Col du Lac' },
      ],
    };
    expect(reopen(serializeMapVideoProject(saved)).project.settings.overlay?.components).toHaveLength(1);
  });

  it('holds the file name and point count of the activity, and nothing of the activity itself', () => {
    const json = serializeMapVideoProject(project());
    const made = activity();
    expect(JSON.parse(json).activity).toEqual({ fileName: 'home-loop.gpx', points: made.points.length });
    for (const point of made.points) {
      expect(json).not.toContain(String(point.lat).slice(0, 8));
      expect(json).not.toContain(String(point.lon).slice(0, 8));
    }
    expect(json).not.toContain('2026-11-10');
    expect(json).not.toContain('432.5');
    expect(json).not.toContain('Sunday loop');
  });

  it('tells whether it was made for the activity open', () => {
    const saved = project();
    expect(isProjectFor(saved, activity())).toBe(true);
    const other = activityThrough(straightNorth(500));
    expect(isProjectFor(saved, other)).toBe(false);
  });

  it('takes the defaults for what a file leaves out', () => {
    const { project: opened } = reopen(withSettings({ lengthSeconds: 20 }));
    expect(opened.settings).toEqual({ ...DEFAULT_MAP_VIDEO_SETTINGS, lengthSeconds: 20 });
  });

  it('refuses a value out of range by name, rather than changing it', () => {
    const pitch = parseMapVideoProject(withSettings({ camera: { pitch: 75 } }));
    expect(pitch).toEqual({ ok: false, error: expect.stringContaining('settings.camera.pitch must be a number from 0 to 60') });
    const color = parseMapVideoProject(withSettings({ route: { color: 'red; background:url(x)' } }));
    expect(color).toEqual({ ok: false, error: expect.stringContaining('settings.route.color') });
    const mode = parseMapVideoProject(withSettings({ timing: { mode: 'speed' } }));
    expect(mode).toEqual({ ok: false, error: expect.stringContaining('settings.timing.mode must be one of distance, time') });
  });

  it('holds 4K to a minute and to 30 frames a second', () => {
    const fourK = { width: 3840, height: 2160, fps: 30 };
    expect(parseMapVideoProject(withSettings({ output: fourK, lengthSeconds: 60 })).ok).toBe(true);
    expect(parseMapVideoProject(withSettings({ output: fourK, lengthSeconds: 61 }))).toEqual({ ok: false, error: expect.stringContaining('1 minute above 1080p') });
    expect(parseMapVideoProject(withSettings({ output: { ...fourK, fps: 60 } }))).toEqual({ ok: false, error: expect.stringContaining('60 frames a second is offered up to 1080p') });
    expect(outputProblem({ output: { width: 1080, height: 1920, fps: 60 }, lengthSeconds: 180 })).toBeUndefined();
    expect(outputProblem({ output: { width: 5000, height: 1000, fps: 30 }, lengthSeconds: 30 })).toMatch(/between 320 and 4096/);
  });

  it('leaves out a setting it does not know, and says so', () => {
    const { warnings } = reopen(withSettings({ music: { file: 'song.mp3' } }));
    expect(warnings).toEqual(['The setting "music" is not known to this version and was left out.']);
  });

  it('refuses another kind of file, a later version, and a file too large', () => {
    expect(parseMapVideoProject('{"kind":"opentrack-overlay-layout","version":1}')).toEqual({ ok: false, error: 'This file is not an OpenTrack map video project.' });
    expect(parseMapVideoProject(JSON.stringify({ kind: MAP_VIDEO_PROJECT_KIND, version: 2 }))).toEqual({
      ok: false,
      error: 'This project is version 2, which this app cannot read.',
    });
    expect(parseMapVideoProject('not json').ok).toBe(false);
    expect(parseMapVideoProject(' '.repeat(300 * 1024)).ok).toBe(false);
  });
});
