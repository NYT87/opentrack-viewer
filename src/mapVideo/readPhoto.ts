import { photoTakenAt, readPhotoExif, type PhotoExif } from './exif';
import type { PhotoInput } from './photos';

/**
 * AV-1208. A photo read in the page: its EXIF (when and where, kept in
 * memory), and its pixels decoded by the browser, upright, and no larger than
 * the video needs. The pixels are what is drawn; nothing else of the file is.
 */
export interface MapVideoPhoto {
  id: string;
  name: string;
  exif: PhotoExif;
  /** The decoded pixels, at most `MAX_PHOTO_SIDE` on the long side. */
  image?: ImageBitmap;
  width: number;
  height: number;
  /** A small picture for the list, drawn from the pixels. */
  thumbnail?: string;
  decodeError?: string;
}

export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif'];
/** The long side photos are kept at: a 4K frame's, which no photo needs more than. */
export const MAX_PHOTO_SIDE = 2048;
export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;

let next = 0;

/** Reads a photo file. Never throws: a photo that cannot be used says why. */
export async function readPhotoFile(file: File): Promise<MapVideoPhoto> {
  next += 1;
  const id = `photo-${next}`;
  const unusable = (decodeError: string, exif: PhotoExif = {}): MapVideoPhoto => ({ id, name: file.name, exif, width: 0, height: 0, decodeError });
  if (file.size > MAX_PHOTO_BYTES) return unusable('It is larger than 50 MB.');
  let exif: PhotoExif;
  try {
    exif = readPhotoExif(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return unusable('It could not be read from your device. Try choosing it again.');
  }
  if (typeof createImageBitmap !== 'function') return unusable('This browser cannot decode photos here.', exif);
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const heic = /\.(heic|heif)$/i.test(file.name);
    return unusable(
      heic
        ? 'This browser cannot decode HEIC photos (Safari can). Convert it to JPEG, or use Safari.'
        : 'It could not be decoded: it may be damaged, or in a format this browser does not read.',
      exif,
    );
  }
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.width, image.height));
  if (scale < 1) {
    const smaller = await createImageBitmap(image, {
      resizeWidth: Math.round(image.width * scale),
      resizeHeight: Math.round(image.height * scale),
      resizeQuality: 'high',
    });
    image.close();
    image = smaller;
  }
  return { id, name: file.name, exif, image, width: image.width, height: image.height, thumbnail: thumbnailOf(image) };
}

function thumbnailOf(image: ImageBitmap): string | undefined {
  try {
    const side = 96;
    const scale = side / Math.max(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return undefined;
  }
}

/**
 * The photo as the model places it: its time taken in UTC, read in the
 * camera's own zone where it wrote one, else the activity's where the file
 * states it (TD-061), else the reader's on that date.
 */
export function photoInput(photo: MapVideoPhoto, activityOffsetMinutes: number | undefined): PhotoInput {
  const readerOffset = photo.exif.localTime ? -new Date(photo.exif.localTime).getTimezoneOffset() : undefined;
  const takenAt = photoTakenAt(photo.exif, activityOffsetMinutes ?? readerOffset);
  return {
    id: photo.id,
    name: photo.name,
    ...(takenAt !== undefined ? { takenAt } : {}),
    ...(photo.exif.lat !== undefined && photo.exif.lon !== undefined ? { lat: photo.exif.lat, lon: photo.exif.lon } : {}),
    ...(photo.decodeError ? { decodeError: photo.decodeError } : {}),
  };
}
