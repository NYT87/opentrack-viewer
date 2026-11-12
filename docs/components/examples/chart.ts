import type { ChartProps, ComponentDraw } from '../../../src/overlay/contract';

/**
 * A chart: the line as the props give it (`runs`, in 0..1 of the box, a gap in the
 * data ending a run), a cursor at `props.cursor`, and the y range's ends where the
 * reader asked for labels. Nothing is drawn across a gap. AV-1019.
 */
export const draw: ComponentDraw<ChartProps> = (ctx, props) => {
  const { box, fontPx, style, runs, cursor, lineColor, fillColor, fillOpacity, labels, showLabels } = props;
  const pad = 0.3 * fontPx;
  const band = showLabels ? 0.7 * fontPx : 0;
  const area = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad - band };
  const px = (x: number) => area.x + x * area.width;
  const py = (y: number) => area.y + y * area.height;

  ctx.save();
  ctx.lineJoin = 'round';
  for (const run of runs) {
    if (run.length === 0) continue;
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.lineTo(px(run[run.length - 1]![0]), area.y + area.height);
    ctx.lineTo(px(run[0]![0]), area.y + area.height);
    ctx.closePath();
    ctx.globalAlpha = fillOpacity;
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(1, 0.025 * area.height);
    ctx.stroke();
  }

  // The cursor, and a dot on the line where the figure has a value.
  ctx.fillStyle = style.accentColor;
  ctx.fillRect(px(cursor.x) - 1, area.y, 2, area.height);
  if (cursor.y !== undefined) {
    ctx.beginPath();
    ctx.arc(px(cursor.x), py(cursor.y), 0.05 * area.height, 0, Math.PI * 2);
    ctx.fill();
  }

  if (labels) {
    ctx.fillStyle = style.textColor;
    ctx.font = `${0.45 * fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    if (labels.yHigh) ctx.fillText(labels.yHigh, area.x, area.y, 0.4 * box.width);
    ctx.fillText(labels.xStart, area.x, area.y + area.height + 0.1 * fontPx, 0.4 * box.width);
    ctx.textAlign = 'right';
    ctx.fillText(labels.xEnd, area.x + area.width, area.y + area.height + 0.1 * fontPx, 0.4 * box.width);
  }
  ctx.restore();
};
