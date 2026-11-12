import type { ComponentDraw, DialProps } from '../../../src/overlay/contract';

/**
 * A dial: a track with the part up to the value filled, ticks inside it, a needle
 * at `props.angleDegrees` and the value written below the needle's pivot. All from
 * absolute points, so what is drawn can be read back. AV-1019.
 */
export const draw: ComponentDraw<DialProps> = (ctx, props) => {
  const { box, fontPx, style, text, fraction, sweepDegrees, angleDegrees, ticks, trackColor, fillColor, needleColor } = props;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) / 2 - 0.4 * fontPx;
  const arcWidth = 0.13 * radius;
  const arcRadius = radius - arcWidth / 2;
  // Degrees clockwise from the top, as a canvas angle.
  const canvasAngle = (degrees: number) => ((degrees - 90) * Math.PI) / 180;
  const at = (r: number, degrees: number) => [cx + r * Math.cos(canvasAngle(degrees)), cy + r * Math.sin(canvasAngle(degrees))] as const;
  const start = -sweepDegrees / 2;

  ctx.save();
  ctx.lineWidth = arcWidth;
  ctx.strokeStyle = trackColor;
  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, canvasAngle(start), canvasAngle(-start));
  ctx.stroke();
  if (fraction > 0) {
    ctx.strokeStyle = fillColor;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, canvasAngle(start), canvasAngle(start + fraction * sweepDegrees));
    ctx.stroke();
  }

  // The ticks, inside the arc: the major ones longer.
  ctx.strokeStyle = trackColor;
  ctx.lineWidth = Math.max(1, 0.02 * radius);
  ctx.beginPath();
  for (const tick of ticks) {
    const degrees = start + tick.fraction * sweepDegrees;
    const [x1, y1] = at(radius - arcWidth - 0.05 * radius, degrees);
    const [x2, y2] = at(radius - arcWidth - (tick.major ? 0.18 : 0.12) * radius, degrees);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, cx, cy + 0.2 * radius, 1.5 * radius);

  const [tx, ty] = at(0.74 * radius, angleDegrees);
  ctx.strokeStyle = needleColor;
  ctx.fillStyle = needleColor;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, 0.045 * radius);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, 0.07 * radius), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};
