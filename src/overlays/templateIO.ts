import { OVERLAY_METRICS, type OverlayMetric } from './timeline';
import type {
  DataBinding,
  OverlayBox,
  OverlayComponent,
  OverlayStyle,
  OverlayTemplate,
} from './template';

/**
 * AV-1003. The overlay project file.
 *
 * What a user saves to reuse a look on another video. It holds the template
 * and nothing about any activity or video: no file names, no coordinates, no
 * timestamps. The app stores nothing itself — this file is the user's.
 *
 * Reading one is the only place this app accepts structured data it did not
 * make, so it is strict. Every field is checked, the result is built from
 * scratch rather than passed through (so extra or hostile properties are
 * dropped, never carried into the renderer), and the first problems found are
 * reported with where they are.
 */

export const PROJECT_FORMAT = 'opentrack-overlay';
export const PROJECT_VERSION = 1;

/** A project file is a few kilobytes; this is a ceiling, not a target. */
export const MAX_PROJECT_BYTES = 256 * 1024;
export const MAX_COMPONENTS = 50;
const MAX_PROBLEMS = 10;
const MAX_TEXT = 80;

export type ParseProjectResult =
  | { ok: true; template: OverlayTemplate }
  | { ok: false; problems: string[] };

/** The file's text for a template. */
export function serializeProject(template: OverlayTemplate): string {
  return `${JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, template }, null, 2)}\n`;
}

class Problems {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    if (this.list.length < MAX_PROBLEMS) this.list.push(`${path}: ${message}`);
  }
  get any(): boolean {
    return this.list.length > 0;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a project file. Never throws: a file that is not JSON, is too large, is
 * the wrong format or version, or has any invalid field comes back as `problems`
 * a person can act on.
 */
export function parseProject(text: string): ParseProjectResult {
  if (text.length > MAX_PROJECT_BYTES) {
    return { ok: false, problems: ['file: is too large to be an overlay project.'] };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['file: is not valid JSON.'] };
  }

  if (!isRecord(data) || data.format !== PROJECT_FORMAT) {
    return { ok: false, problems: ['file: is not an OpenTrack overlay project.'] };
  }
  if (data.version !== PROJECT_VERSION) {
    return {
      ok: false,
      problems: [
        typeof data.version === 'number' && data.version > PROJECT_VERSION
          ? 'file: was made by a newer version of this app and cannot be read here.'
          : 'file: has an unsupported version.',
      ],
    };
  }

  const problems = new Problems();
  const template = readTemplate(data.template, problems);
  if (problems.any || !template) {
    return { ok: false, problems: problems.list.length ? problems.list : ['template: is missing.'] };
  }
  return { ok: true, template };
}

function readTemplate(value: unknown, problems: Problems): OverlayTemplate | undefined {
  if (!isRecord(value)) {
    problems.add('template', 'must be an object.');
    return undefined;
  }
  const name = readText(value.name, 'template.name', problems);
  const units = value.units;
  if (units !== 'metric' && units !== 'imperial') {
    problems.add('template.units', 'must be "metric" or "imperial".');
  }

  const list = value.components;
  if (!Array.isArray(list)) {
    problems.add('template.components', 'must be a list.');
    return undefined;
  }
  if (list.length > MAX_COMPONENTS) {
    problems.add('template.components', `can hold at most ${MAX_COMPONENTS} components.`);
    return undefined;
  }

  const ids = new Set<string>();
  const components: OverlayComponent[] = [];
  list.forEach((entry, index) => {
    const component = readComponent(entry, `template.components[${index}]`, ids, problems);
    if (component) components.push(component);
  });

  if (problems.any || name === undefined) return undefined;
  return { name, units: units as OverlayTemplate['units'], components };
}

function readComponent(
  value: unknown,
  path: string,
  ids: Set<string>,
  problems: Problems,
): OverlayComponent | undefined {
  if (!isRecord(value)) {
    problems.add(path, 'must be an object.');
    return undefined;
  }

  const id = readText(value.id, `${path}.id`, problems);
  if (id !== undefined) {
    if (id === '') problems.add(`${path}.id`, 'cannot be empty.');
    else if (ids.has(id)) problems.add(`${path}.id`, `"${id}" is used twice.`);
    ids.add(id);
  }
  if (typeof value.visible !== 'boolean') problems.add(`${path}.visible`, 'must be true or false.');
  const box = readBox(value.box, `${path}.box`, problems);
  const style = readStyle(value.style, `${path}.style`, problems);

  const type = value.type;
  let extra: Record<string, unknown> | undefined;
  switch (type) {
    case 'text': {
      const binding = readBinding(value.binding, `${path}.binding`, problems);
      const label = value.label === undefined ? undefined : readText(value.label, `${path}.label`, problems);
      extra = binding ? { binding, ...(label !== undefined ? { label } : {}) } : undefined;
      break;
    }
    case 'gauge': {
      const binding = readBinding(value.binding, `${path}.binding`, problems);
      const min = readNumber(value.min, `${path}.min`, problems);
      const max = readNumber(value.max, `${path}.max`, problems);
      if (min !== undefined && max !== undefined && !(min < max)) {
        problems.add(path, 'min must be less than max.');
      }
      const label = value.label === undefined ? undefined : readText(value.label, `${path}.label`, problems);
      extra =
        binding && min !== undefined && max !== undefined
          ? { binding, min, max, ...(label !== undefined ? { label } : {}) }
          : undefined;
      break;
    }
    case 'route': {
      const lineWidth = readNumber(value.lineWidth, `${path}.lineWidth`, problems, 0.5, 50);
      if (typeof value.showMarker !== 'boolean') problems.add(`${path}.showMarker`, 'must be true or false.');
      extra =
        lineWidth !== undefined && typeof value.showMarker === 'boolean'
          ? { lineWidth, showMarker: value.showMarker }
          : undefined;
      break;
    }
    case 'progress':
      extra = {};
      break;
    case 'chart': {
      const binding = readBinding(value.binding, `${path}.binding`, problems);
      const windowSeconds = readNumber(value.windowSeconds, `${path}.windowSeconds`, problems, 5, 600);
      extra = binding && windowSeconds !== undefined ? { binding, windowSeconds } : undefined;
      break;
    }
    default:
      problems.add(`${path}.type`, 'must be "text", "gauge", "route", "progress" or "chart".');
  }

  if (problems.any || id === undefined || !box || !style || !extra || typeof value.visible !== 'boolean') {
    return undefined;
  }
  return { id, type, visible: value.visible, box, style, ...extra } as OverlayComponent;
}

function readText(value: unknown, path: string, problems: Problems): string | undefined {
  if (typeof value !== 'string') {
    problems.add(path, 'must be text.');
    return undefined;
  }
  if (value.length > MAX_TEXT) {
    problems.add(path, `can be at most ${MAX_TEXT} characters.`);
    return undefined;
  }
  return value;
}

function readNumber(
  value: unknown,
  path: string,
  problems: Problems,
  min = -1e9,
  max = 1e9,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(path, 'must be a number.');
    return undefined;
  }
  if (value < min || value > max) {
    problems.add(path, `must be between ${min} and ${max}.`);
    return undefined;
  }
  return value;
}

function readBox(value: unknown, path: string, problems: Problems): OverlayBox | undefined {
  if (!isRecord(value)) {
    problems.add(path, 'must be an object with x, y, width and height.');
    return undefined;
  }
  const x = readNumber(value.x, `${path}.x`, problems, 0, 1);
  const y = readNumber(value.y, `${path}.y`, problems, 0, 1);
  const width = readNumber(value.width, `${path}.width`, problems, 0, 1);
  const height = readNumber(value.height, `${path}.height`, problems, 0, 1);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (width === 0 || height === 0) {
    problems.add(path, 'must have a width and height above zero.');
    return undefined;
  }
  // A small allowance for rounding in a hand-edited file.
  if (x + width > 1.0001 || y + height > 1.0001) {
    problems.add(path, 'must sit inside the frame.');
    return undefined;
  }
  return { x, y, width, height };
}

function readStyle(value: unknown, path: string, problems: Problems): OverlayStyle | undefined {
  if (!isRecord(value)) {
    problems.add(path, 'must be an object.');
    return undefined;
  }
  const color = readColor(value.color, `${path}.color`, problems);
  const accentColor = readColor(value.accentColor, `${path}.accentColor`, problems);
  const backgroundColor = readColor(value.backgroundColor, `${path}.backgroundColor`, problems);
  const fontScale = readNumber(value.fontScale, `${path}.fontScale`, problems, 0.25, 4);
  if (color === undefined || accentColor === undefined || backgroundColor === undefined || fontScale === undefined) {
    return undefined;
  }
  return { color, accentColor, backgroundColor, fontScale };
}

/**
 * A colour is text the canvas will be asked to parse, so it is restricted to
 * the forms a person actually writes: hex, `rgb()`/`rgba()`/`hsl()`/`hsla()`
 * with numbers only, or a plain colour name. Nothing that could be a URL, a
 * function call of another kind, or a script reaches the renderer.
 */
const COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\(\s*[0-9.%\s,/deg-]+\)|[a-z]{3,30})$/i;

/** True for a colour this app will hand to the canvas. */
export function isAcceptableColor(value: string): boolean {
  return value.length <= MAX_TEXT && COLOR_PATTERN.test(value.trim());
}

function readColor(value: unknown, path: string, problems: Problems): string | undefined {
  const text = readText(value, path, problems);
  if (text === undefined) return undefined;
  if (!COLOR_PATTERN.test(text.trim())) {
    problems.add(path, 'must be a colour such as #ffffff or rgba(0, 0, 0, 0.5).');
    return undefined;
  }
  return text.trim();
}

function readBinding(value: unknown, path: string, problems: Problems): DataBinding | undefined {
  if (!isRecord(value)) {
    problems.add(path, 'must be an object.');
    return undefined;
  }
  if (value.kind === 'metric') {
    if (typeof value.metric === 'string' && (OVERLAY_METRICS as readonly string[]).includes(value.metric)) {
      return { kind: 'metric', metric: value.metric as OverlayMetric };
    }
    problems.add(`${path}.metric`, `must be one of ${OVERLAY_METRICS.join(', ')}.`);
    return undefined;
  }
  if (value.kind === 'sensor') {
    const key = readText(value.key, `${path}.key`, problems);
    if (key === undefined) return undefined;
    if (!/^[A-Za-z0-9_.-]{1,20}$/.test(key)) {
      problems.add(`${path}.key`, 'must be a short stream name such as ACCL.');
      return undefined;
    }
    return { kind: 'sensor', key };
  }
  problems.add(`${path}.kind`, 'must be "metric" or "sensor".');
  return undefined;
}
