import { useState } from 'react';
import { download } from './ExportPanel';
import { ActivityError } from '../domain/errors';
import {
  METRIC_INFO,
  type HiddenComponent,
  type OverlayComponent,
  type OverlayDataAvailability,
  type OverlayTemplate,
} from '../overlays/template';
import {
  addComponent,
  canAddComponent,
  describeComponent,
  removeComponent,
  setBox,
  setChartWindow,
  setGaugeRange,
  setLabel,
  setRouteOptions,
  setStyle,
  setVisible,
  type NewComponent,
} from '../overlays/templateEdit';
import { MAX_PROJECT_BYTES, parseProject, serializeProject } from '../overlays/templateIO';
import { OVERLAY_METRICS, type OverlayMetric } from '../overlays/timeline';

export interface OverlayTemplateEditorProps {
  template: OverlayTemplate;
  availability: OverlayDataAvailability;
  /** Components switched on but unable to show anything, with reasons. */
  hidden: HiddenComponent[];
  /** Camera streams that can be bound to, with names to show. */
  sensors: { key: string; label: string }[];
  onChange: (template: OverlayTemplate) => void;
  onImport: (template: OverlayTemplate) => void;
  onReset: () => void;
}

const PANEL = 'rgba(11, 15, 20, 0.55)';
const KINDS: { value: NewComponent['type']; label: string }[] = [
  { value: 'text', label: 'Readout' },
  { value: 'gauge', label: 'Gauge' },
  { value: 'chart', label: 'Chart' },
  { value: 'route', label: 'Route inset' },
  { value: 'progress', label: 'Progress bar' },
];

/** `<input type="color">` only takes #rrggbb; anything else shows as white. */
const asHex = (color: string): string => (/^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff');
const percent = (fraction: number) => Math.round(fraction * 100);

/** The base file name for a saved project. */
const projectFileName = (template: OverlayTemplate): string => {
  const slug = template.name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'overlay'}-overlay-template.json`;
};

/**
 * AV-1005. Controls for the template: what is shown, where, and how it looks.
 *
 * Deliberately not a design editor. Each component gets the handful of controls
 * that cover real needs — show it, move and size it, recolour it — as plain
 * labelled inputs that work on a phone and from a keyboard, and the rest is
 * left to the project file for anyone who wants to go further.
 */
export function OverlayTemplateEditor({
  template,
  availability,
  hidden,
  sensors,
  onChange,
  onImport,
  onReset,
}: OverlayTemplateEditorProps) {
  const [kind, setKind] = useState<NewComponent['type']>('text');
  const [metric, setMetric] = useState<OverlayMetric>('speed');
  const [sensorKey, setSensorKey] = useState('');
  const [bindingKind, setBindingKind] = useState<'metric' | 'sensor'>('metric');
  const [problems, setProblems] = useState<string[]>([]);

  const reasonFor = (id: string) => hidden.find((entry) => entry.component.id === id)?.reason;
  const needsBinding = kind === 'text' || kind === 'gauge' || kind === 'chart';

  const handleAdd = () => {
    if (!needsBinding) {
      onChange(addComponent(template, { type: kind as 'route' | 'progress' }));
      return;
    }
    const binding =
      bindingKind === 'sensor' && sensorKey
        ? ({ kind: 'sensor', key: sensorKey } as const)
        : ({ kind: 'metric', metric } as const);
    onChange(addComponent(template, { type: kind as 'text' | 'gauge' | 'chart', binding }));
  };

  const handleExport = () => {
    const blob = new Blob([serializeProject(template)], { type: 'application/json;charset=utf-8' });
    download(blob, projectFileName(template));
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PROJECT_BYTES) {
      setProblems(['file: is too large to be an overlay project.']);
      return;
    }
    try {
      const result = parseProject(await file.text());
      if (result.ok) {
        setProblems([]);
        onImport(result.template);
      } else {
        setProblems(result.problems);
      }
    } catch (error) {
      setProblems([error instanceof ActivityError ? error.message : 'file: could not be read.']);
    }
  };

  return (
    <div className="template-editor" aria-label="Customize template" role="group">
      <h4 className="prose__title">Customize</h4>

      <div className="route-tools__row">
        <button type="button" className="button" onClick={handleExport}>
          Save project file
        </button>
        <label className="button template-editor__file">
          Load project file
          <input
            type="file"
            accept=".json,application/json"
            data-testid="project-input"
            className="template-editor__file-input"
            onChange={(event) => {
              void handleImport(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
        <button type="button" className="button" onClick={onReset}>
          Reset template
        </button>
      </div>
      <p className="export__hint">
        The project file holds this template only — no video, no route, no figures — so it can be
        reused on another video. Changes last until you close the tab.
      </p>

      {problems.length > 0 && (
        <div role="alert" className="route-tools__notice">
          <p>That file could not be loaded:</p>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="route-tools__row" role="group" aria-label="Add a component">
        <label className="export__label">
          Add{' '}
          <select
            className="select"
            aria-label="Component type"
            value={kind}
            onChange={(event) => setKind(event.target.value as NewComponent['type'])}
          >
            {KINDS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {needsBinding && (
          <label className="export__label">
            Showing{' '}
            <select
              className="select"
              aria-label="Measurement"
              value={bindingKind === 'sensor' ? `sensor:${sensorKey}` : `metric:${metric}`}
              onChange={(event) => {
                const [type, value = ''] = event.target.value.split(':');
                if (type === 'sensor') {
                  setBindingKind('sensor');
                  setSensorKey(value);
                } else {
                  setBindingKind('metric');
                  setMetric(value as OverlayMetric);
                }
              }}
            >
              {OVERLAY_METRICS.map((entry) => {
                const present = availability.metrics.has(entry);
                return (
                  <option key={entry} value={`metric:${entry}`}>
                    {METRIC_INFO[entry].label}
                    {present ? '' : ' (not in this activity)'}
                  </option>
                );
              })}
              {sensors.map((stream) => (
                <option key={stream.key} value={`sensor:${stream.key}`}>
                  {stream.label} (camera)
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="button" onClick={handleAdd} disabled={!canAddComponent(template)}>
          Add component
        </button>
      </div>
      {!canAddComponent(template) && <p role="note">This template has as many components as it can hold.</p>}

      <ul className="template-editor__list">
        {template.components.map((component) => (
          <li key={component.id}>
            <ComponentControls
              component={component}
              reason={component.visible ? reasonFor(component.id) : undefined}
              onChange={onChange}
              template={template}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ComponentControls({
  component,
  template,
  reason,
  onChange,
}: {
  component: OverlayComponent;
  template: OverlayTemplate;
  reason?: string;
  onChange: (template: OverlayTemplate) => void;
}) {
  const name = describeComponent(component);
  const { id, box, style } = component;

  const slider = (
    label: string,
    value: number,
    apply: (fraction: number) => OverlayTemplate,
    min = 0,
    max = 100,
  ) => (
    <label className="template-editor__field">
      {label} {percent(value)}%
      <input
        type="range"
        aria-label={`${name} ${label.toLowerCase()}`}
        min={min}
        max={max}
        value={percent(value)}
        onChange={(event) => onChange(apply(Number(event.target.value) / 100))}
      />
    </label>
  );

  const background = style.backgroundColor === 'transparent' ? 'none' : style.backgroundColor === PANEL ? 'panel' : 'custom';

  return (
    <details className="template-editor__component">
      <summary>
        <label>
          <input
            type="checkbox"
            checked={component.visible}
            aria-label={`Show ${name}`}
            onChange={(event) => onChange(setVisible(template, id, event.target.checked))}
            onClick={(event) => event.stopPropagation()}
          />{' '}
          {name}
        </label>
        {reason && (
          <span className="template-editor__reason" role="note">
            {' '}
            — hidden: {reason}
          </span>
        )}
      </summary>

      <div className="template-editor__body">
        {slider('Left', box.x, (v) => setBox(template, id, { x: v }))}
        {slider('Top', box.y, (v) => setBox(template, id, { y: v }))}
        {slider('Width', box.width, (v) => setBox(template, id, { width: v }), 2)}
        {slider('Height', box.height, (v) => setBox(template, id, { height: v }), 2)}

        <label className="template-editor__field">
          Colour{' '}
          <input
            type="color"
            aria-label={`${name} colour`}
            value={asHex(style.color)}
            onChange={(event) => onChange(setStyle(template, id, { color: event.target.value }))}
          />
        </label>
        <label className="template-editor__field">
          Accent{' '}
          <input
            type="color"
            aria-label={`${name} accent colour`}
            value={asHex(style.accentColor)}
            onChange={(event) => onChange(setStyle(template, id, { accentColor: event.target.value }))}
          />
        </label>
        <label className="template-editor__field">
          Background{' '}
          <select
            className="select"
            aria-label={`${name} background`}
            value={background}
            onChange={(event) =>
              onChange(
                setStyle(template, id, {
                  backgroundColor: event.target.value === 'none' ? 'transparent' : PANEL,
                }),
              )
            }
          >
            <option value="panel">Dark panel</option>
            <option value="none">None</option>
            {background === 'custom' && (
              <option value="custom" disabled>
                Custom
              </option>
            )}
          </select>
        </label>
        {(component.type === 'text' || component.type === 'gauge') && (
          <label className="template-editor__field">
            Text size {style.fontScale.toFixed(2)}×
            <input
              type="range"
              aria-label={`${name} text size`}
              min={50}
              max={200}
              value={Math.round(style.fontScale * 100)}
              onChange={(event) =>
                onChange(setStyle(template, id, { fontScale: Number(event.target.value) / 100 }))
              }
            />
          </label>
        )}

        {(component.type === 'text' || component.type === 'gauge') && (
          <label className="template-editor__field">
            Label{' '}
            <input
              className="input"
              aria-label={`${name} label`}
              value={component.label ?? ''}
              placeholder="Default"
              onChange={(event) =>
                onChange(setLabel(template, id, event.target.value === '' ? undefined : event.target.value))
              }
            />
          </label>
        )}

        {component.type === 'gauge' && (
          <>
            <label className="template-editor__field">
              Dial from{' '}
              <input
                className="input"
                type="number"
                aria-label={`${name} dial minimum`}
                value={component.min}
                onChange={(event) => onChange(setGaugeRange(template, id, Number(event.target.value), component.max))}
              />
            </label>
            <label className="template-editor__field">
              to{' '}
              <input
                className="input"
                type="number"
                aria-label={`${name} dial maximum`}
                value={component.max}
                onChange={(event) => onChange(setGaugeRange(template, id, component.min, Number(event.target.value)))}
              />
            </label>
          </>
        )}

        {component.type === 'route' && (
          <>
            <label className="template-editor__field">
              Line width{' '}
              <input
                className="input"
                type="number"
                min={1}
                aria-label={`${name} line width`}
                value={component.lineWidth}
                onChange={(event) => onChange(setRouteOptions(template, id, { lineWidth: Number(event.target.value) }))}
              />
            </label>
            <label className="template-editor__field">
              <input
                type="checkbox"
                aria-label={`${name} marker`}
                checked={component.showMarker}
                onChange={(event) => onChange(setRouteOptions(template, id, { showMarker: event.target.checked }))}
              />{' '}
              Show where the video is
            </label>
          </>
        )}

        {component.type === 'chart' && (
          <label className="template-editor__field">
            Seconds shown{' '}
            <input
              className="input"
              type="number"
              aria-label={`${name} seconds shown`}
              value={component.windowSeconds}
              onChange={(event) => onChange(setChartWindow(template, id, Number(event.target.value)))}
            />
          </label>
        )}

        <button
          type="button"
          className="button"
          onClick={() => onChange(removeComponent(template, id))}
        >
          Remove {name}
        </button>
      </div>
    </details>
  );
}
