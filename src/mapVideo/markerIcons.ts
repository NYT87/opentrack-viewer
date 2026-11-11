import type { ActivitySport } from '../domain/activity';
import type { MapVideoMarkerShape } from './project';

/**
 * AV-1205. The marker's arrow and sport icons, drawn here as pixels and given
 * to the map as images: no sprite or font is fetched for them, so route only
 * still asks for nothing. Drawn pointing north; the map turns the arrow.
 */

/** Pixels per side of every icon image; the map scales it to the marker's size. */
export const MARKER_ICON_PIXELS = 96;

export type SportIcon = 'cycling' | 'running' | 'walking' | 'other';

/** The pictogram for an activity's sport: hiking is walked, and the rest share a plain mark. */
export function sportIcon(sport: ActivitySport | undefined): SportIcon {
  if (sport === 'cycling') return 'cycling';
  if (sport === 'running') return 'running';
  if (sport === 'walking' || sport === 'hiking') return 'walking';
  return 'other';
}

function line(context: CanvasRenderingContext2D, points: [number, number][]) {
  context.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
  context.stroke();
}

function drawSport(context: CanvasRenderingContext2D, icon: SportIcon) {
  // In a 96-pixel square, white strokes over the marker's disc.
  context.strokeStyle = '#ffffff';
  context.fillStyle = '#ffffff';
  context.lineWidth = 6;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (icon === 'cycling') {
    context.beginPath();
    context.arc(30, 58, 13, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(66, 58, 13, 0, Math.PI * 2);
    context.stroke();
    line(context, [[30, 58], [44, 36], [62, 36], [66, 58]]);
    line(context, [[44, 36], [50, 58], [62, 36]]);
    line(context, [[40, 30], [50, 30]]);
  } else if (icon === 'running' || icon === 'walking') {
    context.beginPath();
    context.arc(52, 22, 7, 0, Math.PI * 2);
    context.fill();
    const stride = icon === 'running' ? 16 : 9;
    line(context, [[50, 32], [46, 54]]);
    line(context, [[46, 54], [46 + stride, 66], [44 + stride, 78]]);
    line(context, [[46, 54], [46 - stride, 68]]);
    line(context, [[50, 36], [50 + stride - 2, 46]]);
    line(context, [[50, 36], [50 - stride + 2, 44]]);
  } else {
    context.beginPath();
    context.arc(48, 48, 11, 0, Math.PI * 2);
    context.fill();
  }
}

/**
 * The marker as an image, or undefined for a dot (drawn by the map itself)
 * or where there is no canvas to draw on.
 */
export function markerIconImage(shape: MapVideoMarkerShape, sport: SportIcon, color: string): ImageData | undefined {
  if (shape === 'dot') return undefined;
  const size = MARKER_ICON_PIXELS;
  let context: CanvasRenderingContext2D | null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    context = canvas.getContext('2d');
  } catch {
    // No canvas here (a test's DOM): the map draws a dot instead.
    context = null;
  }
  if (!context) return undefined;
  context.clearRect(0, 0, size, size);
  if (shape === 'arrow') {
    // A broad arrowhead pointing north, white-edged so it reads on any map.
    context.beginPath();
    context.moveTo(48, 6);
    context.lineTo(86, 86);
    context.lineTo(48, 66);
    context.lineTo(10, 86);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 6;
    context.lineJoin = 'round';
    context.strokeStyle = '#ffffff';
    context.stroke();
  } else {
    context.beginPath();
    context.arc(48, 48, 44, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = '#ffffff';
    context.stroke();
    drawSport(context, sport);
  }
  return context.getImageData(0, 0, size, size);
}
