import type { ComponentDraw, HeadingProps } from '../../../src/overlay/contract';

/**
 * A compass: a ring with its north marked at `props.northAngleDegrees` (so a rose that
 * turns is the ring turned), a needle at `props.needleAngleDegrees`, and the heading
 * written below the pivot. Angles are degrees clockwise from the top. AV-1019.
 */
export const draw: ComponentDraw<HeadingProps> = (ctx, props) => {
  const { box, fontPx, style, text, northAngleDegrees, needleAngleDegrees, roseColor, needleColor, showLabels } = props;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) / 2 - 0.3 * fontPx;
  const at = (r: number, degrees: number) => [cx + r * Math.sin((degrees * Math.PI) / 180), cy - r * Math.cos((degrees * Math.PI) / 180)] as const;

  ctx.save();
  ctx.strokeStyle = roseColor;
  ctx.lineWidth = Math.max(1.5, 0.035 * radius);
  ctx.beginPath();
  ctx.arc(cx, cy, 0.86 * radius, 0, Math.PI * 2);
  ctx.stroke();

  if (showLabels) {
    ctx.font = `700 ${0.2 * radius}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ['N', 'E', 'S', 'W'].forEach((letter, i) => {
      const [x, y] = at(0.6 * radius, northAngleDegrees + 90 * i);
      ctx.fillStyle = letter === 'N' ? needleColor : roseColor;
      ctx.fillText(letter, x, y, 0.5 * radius);
    });
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, cx, cy + 0.14 * radius, 1.3 * radius);

  const [tx, ty] = at(0.8 * radius, needleAngleDegrees);
  const [lx, ly] = at(0.08 * radius, needleAngleDegrees + 90);
  const [rx, ry] = at(0.08 * radius, needleAngleDegrees - 90);
  ctx.fillStyle = needleColor;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(lx, ly);
  ctx.lineTo(rx, ry);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};
