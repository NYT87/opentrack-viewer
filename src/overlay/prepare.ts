import { prepareTemplateFonts, usedFamilies, type FontBytes } from './fonts';
import { brokenImagesMessage, closeImages, decodeTemplateImages } from './images';
import type { OverlayTemplate } from './template';

/** AV-1030, AV-1031. What an export needs before its first frame: decoded pictures and font bytes. */
export type ExportInputs = { ok: true; images?: Record<string, ImageBitmap>; fonts?: FontBytes[] } | { ok: false; message: string };

/** Whether a template needs anything prepared at all: no picture and no font means an export may start at once. */
export const needsPreparing = (template: OverlayTemplate): boolean =>
  template.components.some((component) => component.type === 'image' && component.visible) || usedFamilies(template).length > 0;

/**
 * Decodes the template's pictures once and loads its fonts, together. Nothing is half taken: when a
 * font fails or a picture cannot be read, the decoded pictures are closed and the reason is returned,
 * so an export stops before it writes anything rather than drawing in a fallback.
 */
export async function prepareExportInputs(template: OverlayTemplate, frame: { width: number; height: number }): Promise<ExportInputs> {
  const hasImages = template.components.some((component) => component.type === 'image' && component.visible);
  const [fonts, decoded] = await Promise.all([
    prepareTemplateFonts(template).then(
      (faces) => ({ faces }),
      (error: unknown) => ({ problem: error instanceof Error && error.message ? error.message : 'A font could not be loaded.' }),
    ),
    hasImages ? decodeTemplateImages(template.components, frame) : undefined,
  ]);
  if ('problem' in fonts || (decoded && decoded.broken.length > 0)) {
    if (decoded) closeImages(decoded.images.values());
    return { ok: false, message: 'problem' in fonts ? fonts.problem : brokenImagesMessage(decoded!.broken) };
  }
  return {
    ok: true,
    ...(decoded ? { images: Object.fromEntries(decoded.images) } : {}),
    ...(fonts.faces.length > 0 ? { fonts: fonts.faces } : {}),
  };
}
