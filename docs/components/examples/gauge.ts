import type { ComponentDraw, GaugeProps } from '../../../src/overlay/contract';

/**
 * A gauge: the value written over a track that fills to `props.fraction`, which
 * is already clamped to 0..1 within the reader's range. AV-1017.
 */
export const draw: ComponentDraw<GaugeProps> = (ctx, props) => {
  const { box, fontPx, style, text, fraction } = props;
  const pad = 0.5 * fontPx;
  const trackHeight = 0.25 * fontPx;
  const trackWidth = box.width - 2 * pad;
  const trackY = box.y + box.height - pad - trackHeight;

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = style.textColor;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, box.x + pad, box.y + pad);

  ctx.fillStyle = 'rgb(255 255 255 / 0.25)';
  ctx.fillRect(box.x + pad, trackY, trackWidth, trackHeight);
  ctx.fillStyle = style.accentColor;
  ctx.fillRect(box.x + pad, trackY, trackWidth * fraction, trackHeight);
  ctx.restore();
};
