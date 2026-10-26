import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatFileSize } from '../domain/units';
import { drawStillImage, renderStillImagePng, stillImageFileName } from '../overlay/export/drawStaticImage';
import {
  DEFAULT_ROUTE_IMAGE_OPTIONS,
  ROUTE_IMAGE_ASPECTS,
  ROUTE_IMAGE_LIMITS,
  RouteImageError,
  extractRoute,
} from '../overlay/routeImage';
import {
  DATE_FORMAT_LABELS,
  LAYOUT_FILE_MAX_BYTES,
  ROUTE_COMPONENT_ID,
  SNAP_POSITIONS,
  dateZoneChoice,
  defaultStaticLayout,
  describeStillComponent,
  itemAt,
  moveRect,
  newStillComponent,
  nudgeRect,
  parseStillLayout,
  placedRect,
  planStillImage,
  serializeStillLayout,
  snapRect,
  stillElementChoices,
  stillFontPx,
  type StaticImageLayout,
  type StillElementChoice,
  type StillImageContext,
  type StillImagePlan,
} from '../overlay/staticImage';
import {
  DATE_FORMAT_IDS,
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_TEMPLATE_VERSION,
  SUMMARY_STAT_KEYS,
  sanitizeLabel,
  type DateFormatId,
  type OverlayComponent,
  type SummaryStatKey,
  type TextAlign,
} from '../overlay/template';
import { useInteractionStore } from '../state/interactionStore';
import { measureText } from '../overlay/measureText';
import { ElementRows } from './ElementRows';

/** The long side of the preview, in pixels: the image drawn at this scale. */
const PREVIEW_LONG_SIDE = 640;
/** One press of a nudge: a hundredth of the frame; with Shift, a tenth. */
const NUDGE = 0.01;
const NUDGE_FAR = 0.1;

interface RouteOverlayPanelProps {
  activity: Activity;
  /** The activity is a focused section the reader handed over, not the whole recording. */
  focusedSection?: boolean;
  /** For tests: stand-ins for the encoder and the browser's download. */
  renderPng?: (plan: StillImagePlan) => Promise<Blob>;
  save?: (blob: Blob, fileName: string) => void;
  /** For tests: the reader's time zone, which is otherwise the browser's. */
  readerTimeZone?: string;
}

type Phase =
  | { status: 'idle' }
  | { status: 'rendering' }
  | { status: 'saved'; fileName: string; bytes: number }
  | { status: 'error'; message: string };

type LayoutNotice = { kind: 'saved' | 'loaded'; message: string; warnings: string[] } | { kind: 'error'; message: string };

/**
 * AV-1009 / AV-1010. A still overlay image of an activity, on a transparent
 * background, for placing over a video or a design. It needs no video.
 *
 * By default it is the route alone, fitted into the size asked for, as AV-1009
 * made it. Figures from the summary, the date and free text can be added, and
 * every element is placed where the reader wants it: by pressing and dragging
 * on the preview, or by the position fields, the nudges and the snaps, which
 * need no pointer. Every placement keeps the element inside the frame. The
 * preview is the same drawing as the file, smaller; the file is made in this
 * tab, and the layout can be saved and opened again as JSON. Nothing is
 * uploaded, and no map is drawn under the line.
 */
export function RouteOverlayPanel({
  activity,
  focusedSection = false,
  renderPng = renderStillImagePng,
  save = downloadBlob,
  readerTimeZone,
}: RouteOverlayPanelProps) {
  const id = useId();
  const units = useInteractionStore((state) => state.unitSystem);
  const [width, setWidth] = useState(String(DEFAULT_ROUTE_IMAGE_OPTIONS.width));
  const [height, setHeight] = useState(String(DEFAULT_ROUTE_IMAGE_OPTIONS.height));
  const [paddingPercent, setPaddingPercent] = useState(
    String(DEFAULT_ROUTE_IMAGE_OPTIONS.paddingFraction * 100),
  );
  const [lineWidth, setLineWidth] = useState(String(DEFAULT_ROUTE_IMAGE_OPTIONS.lineWidth));
  const [color, setColor] = useState(DEFAULT_ROUTE_IMAGE_OPTIONS.color);
  const [markers, setMarkers] = useState(DEFAULT_ROUTE_IMAGE_OPTIONS.markers);
  const [components, setComponents] = useState<OverlayComponent[]>(
    () => defaultStaticLayout().template.components,
  );
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [notice, setNotice] = useState<LayoutNotice | undefined>();
  const loadInput = useRef<HTMLInputElement>(null);

  const extracted = useMemo(() => extractRoute(activity), [activity]);
  const context = useMemo<StillImageContext>(
    () => ({ activity, route: extracted, units, readerTimeZone }),
    [activity, extracted, units, readerTimeZone],
  );

  // The route's look is set in pixels for the image in hand, as AV-1009 set
  // it, and kept in the template as a share of the image, so a saved layout
  // fits any size.
  const layout = useMemo<StaticImageLayout>(() => {
    const w = parseNumber(width);
    const h = parseNumber(height);
    const shorter = Math.min(w, h);
    return {
      width: w,
      height: h,
      template: {
        version: OVERLAY_TEMPLATE_VERSION,
        name: 'Still image',
        style: { ...DEFAULT_OVERLAY_STYLE },
        components: components.map((component) =>
          component.type === 'routeInset'
            ? {
                ...component,
                style: { ...component.style, accentColor: color },
                route: {
                  lineWidth: parseNumber(lineWidth) / shorter,
                  padding: parseNumber(paddingPercent) / 100,
                  markers,
                },
              }
            : component,
        ),
      },
    };
  }, [width, height, components, color, lineWidth, paddingPercent, markers]);

  const planned = useMemo(() => planStillImage(layout, context, measureText), [layout, context]);
  const plan = planned.ok ? planned.plan : undefined;
  const aspect = ROUTE_IMAGE_ASPECTS.find(
    (entry) => entry.width === parseNumber(width) && entry.height === parseNumber(height),
  );
  const selected = components.find((component) => component.id === selectedId);
  const hasRoute = components.some((component) => component.type === 'routeInset');

  const update = (componentId: string, change: (component: OverlayComponent) => OverlayComponent) =>
    setComponents((current) => current.map((component) => (component.id === componentId ? change(component) : component)));
  /** Moves an element by its placed box, so a text's measured size is what is kept in the frame. */
  const place = (componentId: string, where: (rect: OverlayComponent['rect']) => OverlayComponent['rect']) =>
    update(componentId, (component) => ({ ...component, rect: where(placedRect(plan, component)) }));

  const handleSave = async () => {
    if (!plan) return;
    setPhase({ status: 'rendering' });
    try {
      const blob = await renderPng(plan);
      const fileName = stillImageFileName(plan);
      save(blob, fileName);
      setPhase({ status: 'saved', fileName, bytes: blob.size });
    } catch (error) {
      setPhase({
        status: 'error',
        message: error instanceof RouteImageError ? error.message : 'The image could not be made.',
      });
    }
  };

  const saveLayout = () => {
    // Each element's box as it is drawn, so a text's measured size travels with it.
    const placed = {
      ...layout,
      template: {
        ...layout.template,
        components: layout.template.components.map((component) => ({ ...component, rect: placedRect(plan, component) })),
      },
    };
    save(new Blob([serializeStillLayout(placed)], { type: 'application/json' }), 'overlay-layout.json');
    setNotice({ kind: 'saved', message: 'Saved overlay-layout.json: the layout and its texts, and nothing of the activity.', warnings: [] });
  };

  const loadLayout = async (file: File) => {
    if (file.size > LAYOUT_FILE_MAX_BYTES) {
      setNotice({ kind: 'error', message: `${file.name} is too large to be a layout.` });
      return;
    }
    const parsed = parseStillLayout(await file.text());
    if (!parsed.ok) {
      setNotice({ kind: 'error', message: `${file.name} was not opened. ${parsed.error}` });
      return;
    }
    const next = parsed.layout;
    const shorter = Math.min(next.width, next.height);
    setWidth(String(next.width));
    setHeight(String(next.height));
    const route = next.template.components.find((component) => component.type === 'routeInset');
    if (route?.route) {
      setLineWidth(String(Math.round(route.route.lineWidth * shorter * 100) / 100));
      setPaddingPercent(String(Math.round(route.route.padding * 10_000) / 100));
      setMarkers(route.route.markers);
    }
    if (route?.style.accentColor) setColor(route.style.accentColor);
    setComponents(next.template.components);
    setSelectedId(undefined);
    setNotice({ kind: 'loaded', message: `Opened the layout in ${file.name}.`, warnings: parsed.warnings });
  };

  const add = (key: StillElementChoice['key']) => {
    const component = newStillComponent(layout.template, key, layout);
    setComponents((current) => (key === 'route' ? [component, ...current] : [...current, component]));
    setSelectedId(component.id);
  };

  return (
    <section className="prose overlay-controls still-image" aria-label="Overlay image">
      <h3 className="prose__title">Overlay image</h3>
      <p>
        {focusedSection
          ? 'The focused section of the activity, as a picture on a transparent background.'
          : 'The whole activity, as a picture on a transparent background.'}{' '}
        No map is drawn under it. Add figures, the date or your own text, and place each where you
        want it.
      </p>

      {plan ? (
        <>
          <div className="overlay-controls__group route-image__stage">
            <StillPreview
              plan={plan}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={(componentId, x, y) => update(componentId, (component) => ({ ...component, rect: moveRect(placedRect(plan, component), x, y) }))}
              onNudge={(dx, dy) => selectedId && place(selectedId, (rect) => nudgeRect(rect, dx, dy))}
            />
          </div>
          {plan.notes.map((note) => (
            <p key={note} className="overlay-controls__hint">
              {note}
            </p>
          ))}
          {plan.hidden.length > 0 && (
            <ul className="still-image__hidden" aria-label="Not drawn">
              {plan.hidden.map((entry) => (
                <li key={entry.id}>
                  {entry.label} is not drawn. {entry.reason}
                </li>
              ))}
            </ul>
          )}
          <p className="overlay-controls__hint" data-testid="route-image-size">
            {plan.width} × {plan.height} px, PNG with a transparent background.
          </p>
        </>
      ) : (
        <p role="alert" className="export__error">
          {planned.ok ? '' : planned.error.message}
        </p>
      )}


      <fieldset className="overlay-controls__group">
        <legend>Size</legend>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-aspect`}>Aspect ratio</label>
          <select
            id={`${id}-aspect`}
            className="select"
            value={aspect?.id ?? 'custom'}
            onChange={(event) => {
              const chosen = ROUTE_IMAGE_ASPECTS.find((entry) => entry.id === event.target.value);
              if (!chosen) return;
              setWidth(String(chosen.width));
              setHeight(String(chosen.height));
            }}
          >
            {ROUTE_IMAGE_ASPECTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            {!aspect && <option value="custom">Custom</option>}
          </select>
        </div>
        <NumberField id={`${id}-width`} label="Width (px)" value={width} onChange={setWidth} min={ROUTE_IMAGE_LIMITS.minSide} max={ROUTE_IMAGE_LIMITS.maxSide} />
        <NumberField id={`${id}-height`} label="Height (px)" value={height} onChange={setHeight} min={ROUTE_IMAGE_LIMITS.minSide} max={ROUTE_IMAGE_LIMITS.maxSide} />
      </fieldset>

      {hasRoute && (
        <fieldset className="overlay-controls__group">
          <legend>Route</legend>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-color`}>Route colour</label>
            <input
              id={`${id}-color`}
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ROUTE_IMAGE_OPTIONS.color}
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
          <NumberField id={`${id}-line`} label="Route width (px)" value={lineWidth} onChange={setLineWidth} min={ROUTE_IMAGE_LIMITS.minLineWidth} max={ROUTE_IMAGE_LIMITS.maxLineWidth} decimal />
          <NumberField id={`${id}-padding`} label="Padding (% of the shorter side)" value={paddingPercent} onChange={setPaddingPercent} min={0} max={ROUTE_IMAGE_LIMITS.maxPaddingFraction * 100} decimal />
          <label className="overlay-controls__choice">
            <input type="checkbox" checked={markers} onChange={(event) => setMarkers(event.target.checked)} />
            <span>Mark the start and the end</span>
          </label>
        </fieldset>
      )}

      <ElementList
        components={components}
        plan={plan}
        selectedId={selectedId}
        choices={stillElementChoices(context).filter((choice) => choice.key !== 'route' || !hasRoute)}
        onSelect={setSelectedId}
        onAdd={add}
        onRemove={(removed) => {
          setComponents((current) => current.filter((component) => component.id !== removed));
          if (removed === selectedId) setSelectedId(undefined);
        }}
      />

      {selected && (
        <ElementEditor
          key={selected.id}
          component={selected}
          plan={plan}
          context={context}
          imageWidth={layout.width}
          onChange={(change) => update(selected.id, change)}
          onPlace={(where) => place(selected.id, where)}
          onRemove={() => {
            setComponents((current) => current.filter((component) => component.id !== selected.id));
            setSelectedId(undefined);
          }}
        />
      )}

      <p className="video__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!plan || phase.status === 'rendering'}
          onClick={() => void handleSave()}
        >
          {phase.status === 'rendering' ? 'Making the image…' : 'Download PNG'}
        </button>
      </p>
      {phase.status === 'saved' && (
        <p role="status" className="export__saved">
          Saved {phase.fileName} ({formatFileSize(phase.bytes)}).
        </p>
      )}
      {phase.status === 'error' && (
        <p role="alert" className="export__error">
          {phase.message}
        </p>
      )}

      <div className="still-image__layout" role="group" aria-label="Layout file">
        <p className="overlay-controls__hint">
          A layout keeps where each element is and how it is set, to use on another activity. It
          holds nothing of this one.
        </p>
        <p className="video__actions">
          <button type="button" className="button" onClick={saveLayout} disabled={!planned.ok}>
            Save layout
          </button>
          <button type="button" className="button" onClick={() => loadInput.current?.click()}>
            Open a layout
          </button>
          <input
            ref={loadInput}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="still-layout-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void loadLayout(file);
            }}
          />
        </p>
        {notice && (
          <div role={notice.kind === 'error' ? 'alert' : 'status'} aria-label="Layout file result">
            <p>{notice.message}</p>
            {notice.kind !== 'error' && notice.warnings.length > 0 && (
              <ul>
                {notice.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  decimal = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  decimal?: boolean;
}) {
  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        type="number"
        inputMode={decimal ? 'decimal' : 'numeric'}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ElementList({
  components,
  plan,
  selectedId,
  choices,
  onSelect,
  onAdd,
  onRemove,
}: {
  components: OverlayComponent[];
  plan: StillImagePlan | undefined;
  selectedId: string | undefined;
  choices: StillElementChoice[];
  onSelect: (id: string | undefined) => void;
  onAdd: (key: StillElementChoice['key']) => void;
  onRemove: (id: string) => void;
}) {
  const id = useId();
  const firstAvailable = choices.find((choice) => choice.available)?.key;
  const [wanted, setWanted] = useState<StillElementChoice['key'] | undefined>();
  const chosen = choices.find((choice) => choice.key === wanted && choice.available)?.key ?? firstAvailable;
  const unavailable = choices.filter((choice) => !choice.available);

  return (
    <fieldset className="overlay-controls__group">
      <legend>Elements</legend>
      {components.length > 0 ? (
        <ElementRows
          label="Elements on the image"
          rows={components.map((component) => ({
            id: component.id,
            name: describeStillComponent(component),
            note: plan?.hidden.some((entry) => entry.id === component.id) ? 'not drawn' : undefined,
          }))}
          selectedId={selectedId}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ) : (
        <p className="overlay-controls__hint">Nothing is on the image yet.</p>
      )}
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-add`}>Add</label>
        <select id={`${id}-add`} className="select" value={chosen ?? ''} onChange={(event) => setWanted(event.target.value as StillElementChoice['key'])}>
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key} disabled={!choice.available}>
              {choice.label}
              {choice.available ? '' : ' (not in this activity)'}
            </option>
          ))}
        </select>
        <button type="button" className="button" disabled={!chosen} onClick={() => chosen && onAdd(chosen)}>
          Add to the image
        </button>
      </div>
      {unavailable.length > 0 && (
        <ul className="still-image__unavailable" aria-label="Not in this activity">
          {unavailable.map((choice) => (
            <li key={choice.key} className="overlay-controls__hint">
              {choice.label}: {choice.reason}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

const STAT_LABELS: Record<SummaryStatKey, string> = {
  speed: 'Average speed',
  pace: 'Average pace',
  distance: 'Distance',
  elapsed: 'Elapsed time',
  moving: 'Moving time',
};

function ElementEditor({
  component,
  plan,
  context,
  imageWidth,
  onChange,
  onPlace,
  onRemove,
}: {
  component: OverlayComponent;
  plan: StillImagePlan | undefined;
  context: StillImageContext;
  imageWidth: number;
  onChange: (change: (component: OverlayComponent) => OverlayComponent) => void;
  onPlace: (where: (rect: OverlayComponent['rect']) => OverlayComponent['rect']) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const rect = placedRect(plan, component);
  const percent = (value: number) => String(Math.round(value * 10_000) / 100);
  const isText = component.type !== 'routeInset';
  const fontPx = Number.isFinite(imageWidth) ? Math.round(stillFontPx(component, imageWidth)) : undefined;
  const choices = stillElementChoices(context);
  const name = describeStillComponent(component);

  return (
    <fieldset className="overlay-controls__group still-image__editor" aria-label={`Selected: ${name}`}>
      <legend>Selected: {name}</legend>

      <div className="still-image__position">
        <PercentField
          id={`${id}-x`}
          label="From the left (%)"
          value={percent(rect.x)}
          onCommit={(value) => onPlace((current) => moveRect(current, value / 100, current.y))}
        />
        <PercentField
          id={`${id}-y`}
          label="From the top (%)"
          value={percent(rect.y)}
          onCommit={(value) => onPlace((current) => moveRect(current, current.x, value / 100))}
        />
      </div>
      <div className="still-image__nudges" role="group" aria-label="Move by 1% of the image">
        <button type="button" className="button" aria-label="Move left" onClick={() => onPlace((current) => nudgeRect(current, -NUDGE, 0))}>←</button>
        <button type="button" className="button" aria-label="Move up" onClick={() => onPlace((current) => nudgeRect(current, 0, -NUDGE))}>↑</button>
        <button type="button" className="button" aria-label="Move down" onClick={() => onPlace((current) => nudgeRect(current, 0, NUDGE))}>↓</button>
        <button type="button" className="button" aria-label="Move right" onClick={() => onPlace((current) => nudgeRect(current, NUDGE, 0))}>→</button>
      </div>
      <div className="still-image__snaps" role="group" aria-label="Snap to an edge or a corner">
        {SNAP_POSITIONS.map((position) => (
          <button
            key={position.id}
            type="button"
            className="button"
            aria-label={`Snap to ${position.label.toLowerCase()}`}
            title={position.label}
            onClick={() => onPlace((current) => snapRect(current, position.id))}
          >
            <span aria-hidden="true" className={`still-image__snap still-image__snap--${position.id}`} />
          </button>
        ))}
      </div>

      {component.type === 'routeInset' && (
        <div className="still-image__position">
          <PercentField
            id={`${id}-w`}
            label="Width (% of the image)"
            value={percent(component.rect.width)}
            onCommit={(value) =>
              onChange((current) => {
                const widthFraction = Math.min(1, Math.max(0.05, value / 100));
                return { ...current, rect: moveRect({ ...current.rect, width: widthFraction }, current.rect.x, current.rect.y) };
              })
            }
          />
          <PercentField
            id={`${id}-h`}
            label="Height (% of the image)"
            value={percent(component.rect.height)}
            onCommit={(value) =>
              onChange((current) => {
                const heightFraction = Math.min(1, Math.max(0.05, value / 100));
                return { ...current, rect: moveRect({ ...current.rect, height: heightFraction }, current.rect.x, current.rect.y) };
              })
            }
          />
        </div>
      )}

      {component.type === 'label' && (
        <div className="overlay-controls__field still-image__text">
          <label htmlFor={`${id}-content`}>Text</label>
          <textarea
            id={`${id}-content`}
            className="input"
            rows={2}
            value={component.content ?? ''}
            onChange={(event) => {
              const content = sanitizeLabel(event.target.value);
              onChange((current) => ({ ...current, content }));
            }}
          />
        </div>
      )}

      {component.type === 'summary' && (
        <>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-stat`}>Figure</label>
            <select
              id={`${id}-stat`}
              className="select"
              value={component.summary?.stat}
              onChange={(event) => {
                const stat = event.target.value as SummaryStatKey;
                onChange((current) => ({ ...current, summary: { stat } }));
              }}
            >
              {SUMMARY_STAT_KEYS.map((stat) => {
                const choice = choices.find((entry) => entry.key === stat);
                return (
                  <option key={stat} value={stat} disabled={!choice?.available}>
                    {STAT_LABELS[stat]}
                    {choice?.available ? '' : ' (not in this activity)'}
                  </option>
                );
              })}
            </select>
          </div>
          <label className="overlay-controls__choice">
            <input
              type="checkbox"
              checked={component.text?.caption !== false}
              onChange={(event) => {
                const caption = event.target.checked;
                onChange((current) => ({ ...current, text: { align: 'left', weight: 'bold', ...current.text, caption } }));
              }}
            />
            <span>Show its name above it</span>
          </label>
        </>
      )}

      {component.type === 'date' && <DateSettings id={id} component={component} context={context} onChange={onChange} />}

      {isText && (
        <>
          <PercentField
            id={`${id}-size`}
            label="Text size (px)"
            value={fontPx === undefined ? '' : String(fontPx)}
            min={4}
            max={1000}
            onCommit={(value) =>
              onChange((current) => ({
                ...current,
                style: { ...current.style, fontScale: Math.max(0.1, value / stillFontPx({ ...current, style: { fontScale: 1 } }, imageWidth)) },
              }))
            }
          />
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-text-color`}>Text colour</label>
            <input
              id={`${id}-text-color`}
              type="color"
              value={component.style.textColor ?? DEFAULT_OVERLAY_STYLE.textColor}
              onChange={(event) => {
                const textColor = event.target.value;
                onChange((current) => ({ ...current, style: { ...current.style, textColor } }));
              }}
            />
          </div>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-align`}>Alignment</label>
            <select
              id={`${id}-align`}
              className="select"
              value={component.text?.align ?? 'left'}
              onChange={(event) => {
                const align = event.target.value as TextAlign;
                onChange((current) => ({ ...current, text: { weight: 'bold', ...current.text, align } }));
              }}
            >
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </select>
          </div>
          <label className="overlay-controls__choice">
            <input
              type="checkbox"
              checked={(component.text?.weight ?? 'bold') === 'bold'}
              onChange={(event) => {
                const weight = event.target.checked ? 'bold' : 'normal';
                onChange((current) => ({ ...current, text: { align: 'left', ...current.text, weight } }));
              }}
            />
            <span>Bold</span>
          </label>
        </>
      )}

      <p className="video__actions">
        <button type="button" className="button" onClick={onRemove}>
          Remove {component.id === ROUTE_COMPONENT_ID ? 'the route' : 'this element'}
        </button>
      </p>
    </fieldset>
  );
}

export function DateSettings({
  id,
  component,
  context,
  onChange,
}: {
  id: string;
  component: OverlayComponent;
  context: StillImageContext;
  onChange: (change: (component: OverlayComponent) => OverlayComponent) => void;
}) {
  const setting = component.date ?? { format: 'medium' as DateFormatId, withTime: false, timeZone: 'reader' as const };
  const activityZone = dateZoneChoice('activity', context);
  const readerZone = dateZoneChoice('reader', context);
  const set = (patch: Partial<typeof setting>) => onChange((current) => ({ ...current, date: { ...setting, ...patch } }));
  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-format`}>Date format</label>
        <select
          id={`${id}-format`}
          className="select"
          value={setting.format}
          onChange={(event) => set({ format: event.target.value as DateFormatId })}
        >
          {DATE_FORMAT_IDS.map((format) => (
            <option key={format} value={format}>
              {DATE_FORMAT_LABELS[format]}
            </option>
          ))}
        </select>
      </div>
      <label className="overlay-controls__choice">
        <input type="checkbox" checked={setting.withTime} onChange={(event) => set({ withTime: event.target.checked })} />
        <span>With the time</span>
      </label>
      <fieldset className="still-image__zones">
        <legend>Time zone</legend>
        <label className="overlay-controls__choice">
          <input
            type="radio"
            name={`${id}-zone`}
            checked={setting.timeZone === 'activity'}
            disabled={!activityZone.ok}
            onChange={() => set({ timeZone: 'activity' })}
          />
          <span>
            The activity’s: {activityZone.ok ? activityZone.description : <span className="overlay-controls__hint">{activityZone.reason}</span>}
          </span>
        </label>
        <label className="overlay-controls__choice">
          <input
            type="radio"
            name={`${id}-zone`}
            checked={setting.timeZone === 'reader'}
            onChange={() => set({ timeZone: 'reader' })}
          />
          <span>{readerZone.ok ? readerZone.description : 'Yours'}</span>
        </label>
      </fieldset>
    </>
  );
}

/**
 * A number typed for a position or a size, applied when it is a number: a
 * half-typed or empty field is left as typed until it reads as one, then the
 * value is kept inside the frame and the field shows where it really went.
 */
export function PercentField({
  id,
  label,
  value,
  onCommit,
  min = 0,
  max = 100,
}: {
  id: string;
  label: string;
  value: string;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<string | undefined>();
  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={1}
        value={draft ?? value}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseNumber(event.target.value);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
        onBlur={() => setDraft(undefined)}
      />
    </div>
  );
}

/**
 * The image drawn smaller, with the selected element outlined. Pressing on an
 * element selects it and dragging moves it; pressing elsewhere moves the
 * selected element there. The arrow keys move the selected element too, so
 * none of this needs a pointer.
 */
function StillPreview({
  plan,
  selectedId,
  onSelect,
  onMove,
  onNudge,
}: {
  plan: StillImagePlan;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onMove: (id: string, x: number, y: number) => void;
  onNudge: (dx: number, dy: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | undefined>(undefined);
  const factor = Math.min(1, PREVIEW_LONG_SIDE / Math.max(plan.width, plan.height));
  const previewWidth = Math.max(1, Math.round(plan.width * factor));
  const previewHeight = Math.max(1, Math.round(plan.height * factor));

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform?.(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, previewWidth, previewHeight);
    ctx.scale(previewWidth / plan.width, previewHeight / plan.height);
    drawStillImage(ctx, plan);
    const chosen = plan.items.find((item) => item.id === selectedId);
    if (chosen) {
      // The outline is the preview's own: it is never part of the file.
      ctx.save();
      ctx.setLineDash?.([8 / factor, 6 / factor]);
      ctx.lineWidth = 2 / factor;
      ctx.strokeStyle = '#3b82f6';
      ctx.strokeRect(chosen.box.x, chosen.box.y, chosen.box.w, chosen.box.h);
      ctx.restore();
    }
  }, [plan, selectedId, previewWidth, previewHeight, factor]);

  /** A pointer's place in the image, in its own pixels. */
  const toImage = (event: React.PointerEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / (bounds.width || 1)) * plan.width,
      y: ((event.clientY - bounds.top) / (bounds.height || 1)) * plan.height,
    };
  };

  return (
    <div
      className="still-image__preview"
      tabIndex={0}
      role="group"
      aria-label="Image preview. Press an element to select it, drag to move it. The arrow keys move the selected element; with Shift, further."
      onKeyDown={(event) => {
        const step = event.shiftKey ? NUDGE_FAR : NUDGE;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const move = moves[event.key];
        if (!move || !selectedId) return;
        event.preventDefault();
        onNudge(move[0], move[1]);
      }}
    >
      <canvas
        ref={ref}
        className="route-image__canvas"
        width={previewWidth}
        height={previewHeight}
        style={{ aspectRatio: `${plan.width} / ${plan.height}` }}
        role="img"
        aria-label={`Preview, ${plan.width} by ${plan.height} pixels, transparent background`}
        data-testid="route-image-preview"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const at = toImage(event);
          const hit = itemAt(plan, at.x, at.y);
          if (hit) {
            const box = plan.items.find((item) => item.id === hit)!.box;
            onSelect(hit);
            drag.current = { id: hit, dx: at.x - box.x, dy: at.y - box.y };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            return;
          }
          // Pressing on nothing moves the selected element there, centred on the press.
          const chosen = plan.items.find((item) => item.id === selectedId);
          if (chosen) onMove(chosen.id, (at.x - chosen.box.w / 2) / plan.width, (at.y - chosen.box.h / 2) / plan.height);
        }}
        onPointerMove={(event) => {
          const press = drag.current;
          if (!press) return;
          const at = toImage(event);
          onMove(press.id, (at.x - press.dx) / plan.width, (at.y - press.dy) / plan.height);
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      />
    </div>
  );
}

/** An empty or half-typed field is not a number: it is refused, not read as zero. */
function parseNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/** Hands the blob to the browser's download, then lets go of it (as the viewer's export does). */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
