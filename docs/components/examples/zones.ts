import type { ComponentDraw, ZoneProps } from '../../../src/overlay/contract';

/**
 * Zones as a horizontal bar: one segment per zone in the zone's own colour, the
 * current one bright and the others dimmed, with a marker at the value's place
 * in its zone. The zone's name and the value are written above it. AV-1018.
 */
export const draw: ComponentDraw<ZoneProps> = (ctx, props) => {
  const { box, fontPx, style, zones, zoneIndex, fractionInZone, text } = props;
  const pad = 0.5 * fontPx;
  const gap = 0.1 * fontPx;
  const barHeight = 0.8 * fontPx;
  const width = box.width - 2 * pad;
  const segment = (width - gap * (zones.length - 1)) / zones.length;
  const barY = box.y + box.height - pad - barHeight;

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  const current = zones[zoneIndex]!;
  ctx.fillText(`${current.name} ${text}`, box.x + pad, box.y + pad, width);

  zones.forEach((zone, i) => {
    ctx.globalAlpha = i === zoneIndex ? 1 : 0.35;
    ctx.fillStyle = zone.color;
    ctx.fillRect(box.x + pad + i * (segment + gap), barY, segment, barHeight);
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.textColor;
  ctx.fillRect(box.x + pad + zoneIndex * (segment + gap) + fractionInZone * segment - 1, barY, 2, barHeight);
  ctx.restore();
};
