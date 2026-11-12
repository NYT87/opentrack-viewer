import type { ComponentDraw, RouteProps } from '../../../src/overlay/contract';

/**
 * The elevation profile: the line, a soft fill under it and a cursor at
 * `props.progress`. A gap in the elevation is the end of a run, and no line is
 * drawn across it. AV-1017.
 */
export const draw: ComponentDraw<RouteProps> = (ctx, props) => {
  const { box, style, profile, progress } = props;
  if (!profile) return;
  const px = (x: number) => box.x + x * box.width;
  const py = (y: number) => box.y + y * box.height;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const run of profile.runs) {
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last) continue;
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.lineTo(px(last[0]), box.y + box.height);
    ctx.lineTo(px(first[0]), box.y + box.height);
    ctx.closePath();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = style.textColor;
    ctx.fill();

    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = style.textColor;
    ctx.lineWidth = Math.max(1, 0.025 * box.height);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.accentColor;
  // The cursor is kept inside the box, so it does not poke out at the ends of the activity.
  const bar = Math.max(2, 0.02 * box.height);
  if (progress !== undefined) {
    ctx.fillRect(Math.min(Math.max(px(progress) - bar / 2, box.x), box.x + box.width - bar), box.y, bar, box.height);
  }
  if (profile.cursor) {
    const r = 0.06 * box.height;
    const cx = Math.min(Math.max(px(profile.cursor[0]), box.x + r), box.x + box.width - r);
    ctx.beginPath();
    ctx.arc(cx, py(profile.cursor[1]), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};
