import type { ComponentDraw, RouteProps } from '../../../src/overlay/contract';

/**
 * The route with a dot where the activity is. `props.route` holds the shape in
 * 0..1 of the box, so it is scaled by the box, not by the frame. Draws nothing
 * when the activity has no route to show. AV-1017.
 */
export const draw: ComponentDraw<RouteProps> = (ctx, props) => {
  const { box, style, route } = props;
  if (!route) return;
  ctx.save();
  ctx.strokeStyle = style.textColor;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 0.03 * box.height;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const segment of route.segments) {
    ctx.beginPath();
    segment.forEach(([x, y], index) => {
      const px = box.x + x * box.width;
      const py = box.y + y * box.height;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (route.position) {
    const [x, y] = route.position;
    ctx.fillStyle = style.accentColor;
    ctx.beginPath();
    const r = 0.05 * box.height;
    // Kept inside the box: the route's own margin is 8 % of it, less than the dot in a tall box.
    const cx = Math.min(Math.max(box.x + x * box.width, box.x + r), box.x + box.width - r);
    const cy = Math.min(Math.max(box.y + y * box.height, box.y + r), box.y + box.height - r);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};
