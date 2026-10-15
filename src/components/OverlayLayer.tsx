import { useMemo, type CSSProperties } from 'react';
import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { projectRoute } from '../overlay/routeProjection';
import {
  resolveOverlayComponent,
  type OverlayComponent,
  type OverlayTemplate,
  type ResolvedOverlayComponent,
} from '../overlay/template';
import type { OverlaySample, OverlayTimeline } from '../overlay/timeline';

interface OverlayLayerProps {
  template: OverlayTemplate;
  timeline: OverlayTimeline;
  sample: OverlaySample | undefined;
  activity: Activity | undefined;
  units: UnitSystem;
  /** Width over height of the video frame, so insets are not stretched. */
  frameAspect: number;
}

/**
 * AV-1004. Draws a template's components over a video frame at one sample.
 * Pure of the video element: it takes a sample, so seeking, scrubbing and
 * playback all reach the same drawing. A component with no data for this
 * moment renders nothing — never a dash or an empty box (AV-1003).
 */
export function OverlayLayer({
  template,
  timeline,
  sample,
  activity,
  units,
  frameAspect,
}: OverlayLayerProps) {
  return (
    <div className="overlay-layer" data-testid="overlay-layer">
      {template.components.map((component) => {
        const resolved = resolveOverlayComponent(template, component, sample, timeline, units);
        if (resolved.status !== 'ready') return null;
        return (
          <OverlayItem
            key={component.id}
            resolved={resolved}
            sample={sample}
            activity={activity}
            frameAspect={frameAspect}
          />
        );
      })}
    </div>
  );
}

function boxStyle(component: OverlayComponent, resolved: Extract<ResolvedOverlayComponent, { status: 'ready' }>): CSSProperties {
  const { rect } = component;
  const { style } = resolved;
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
    color: style.textColor,
    background: `rgb(0 0 0 / ${style.backgroundOpacity})`,
    fontSize: `calc(${style.fontScale} * 2.2cqw)`,
    ['--overlay-accent' as string]: style.accentColor,
  };
}

function OverlayItem({
  resolved,
  sample,
  activity,
  frameAspect,
}: {
  resolved: Extract<ResolvedOverlayComponent, { status: 'ready' }>;
  sample: OverlaySample | undefined;
  activity: Activity | undefined;
  frameAspect: number;
}) {
  const { component } = resolved;
  const style = boxStyle(component, resolved);
  const base = `overlay-item overlay-item--${component.type}`;

  if (component.type === 'routeInset') {
    return (
      <div className={base} style={style} data-component={component.id}>
        <RouteInset
          activity={activity}
          sample={sample}
          aspect={(component.rect.width * frameAspect) / component.rect.height}
        />
      </div>
    );
  }
  if (component.type === 'progress') {
    return (
      <div className={base} style={style} data-component={component.id}>
        <div className="overlay-item__bar" style={{ width: `${(resolved.fraction ?? 0) * 100}%` }} />
      </div>
    );
  }
  return (
    <div className={base} style={style} data-component={component.id}>
      <span className="overlay-item__label">{resolved.label}</span>
      <span className="overlay-item__value">{resolved.text}</span>
      {resolved.fraction !== undefined && (
        <div className="overlay-item__track">
          <div className="overlay-item__bar" style={{ width: `${resolved.fraction * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function RouteInset({
  activity,
  sample,
  aspect,
}: {
  activity: Activity | undefined;
  sample: OverlaySample | undefined;
  aspect: number;
}) {
  // The route does not change as the video plays; only the dot moves. Both
  // the projection and the point strings are built once per activity and box,
  // so a frame costs one circle, not a pass over every point.
  const route = useMemo(() => (activity ? projectRoute(activity, aspect) : undefined), [activity, aspect]);
  const paths = useMemo(
    () => route?.segments.map((segment) => segment.map(([x, y]) => `${x * aspect},${y}`).join(' ')),
    [route, aspect],
  );
  if (!route || !paths) return null;
  const dot = sample?.position ? route.project(sample.position) : undefined;
  return (
    <svg
      className="overlay-item__route"
      viewBox={`0 0 ${aspect} 1`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {paths.map((points, index) => (
        <polyline
          key={index}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.8"
          strokeWidth="0.03"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {dot && <circle cx={dot[0] * aspect} cy={dot[1]} r="0.05" fill="var(--overlay-accent)" />}
    </svg>
  );
}
