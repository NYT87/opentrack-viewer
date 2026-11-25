import type { ActivitySourceFormat } from '../domain/activity';
import {
  SUPPORTED_FORMATS,
  detectXmlRoot,
  extensionOf,
  isFitSignature,
  isIsoBaseMediaSignature,
  readHead,
} from '../parsers/detectFormat';
import { VIDEO_EXTENSIONS } from './readVideoTelemetry';

/** What the overlay page takes a file to be: the video to draw over, or the activity to draw. */
export type OverlayFileKind = 'video' | 'activity';

export interface ClassifiedOverlayFile {
  file: File;
  kind: OverlayFileKind | undefined;
}

/**
 * AV-1014. What a file is, for the overlay page's one input.
 *
 * Its first bytes decide where they say: an ISO base media box is a video; the
 * FIT signature or a GPX, TCX or KML root is an activity. Else its extension
 * does. Only the head is read: whether a video carries GoPro telemetry is
 * asked of the whole file later, by the one read that already does so, and not
 * here, where a multi-gigabyte recording would be scanned twice.
 */
export async function classifyOverlayFile(file: File): Promise<OverlayFileKind | undefined> {
  try {
    const head = await readHead(file);
    if (isIsoBaseMediaSignature(head)) return 'video';
    if (isFitSignature(head) || detectXmlRoot(head)) return 'activity';
  } catch {
    // A head that cannot be read is no reason to refuse: the name still says.
  }
  const extension = extensionOf(file.name);
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if ((SUPPORTED_FORMATS as ActivitySourceFormat[]).includes(extension as ActivitySourceFormat)) {
    return 'activity';
  }
  return undefined;
}

export interface SortedOverlayFiles {
  video?: File;
  activity?: File;
  /** Why some were not taken, naming each; absent when all were. */
  refusal?: string;
}

const quoted = (files: File[]) => files.map((file) => `"${file.name}"`);

/** `"a" and "b"`, `"a", "b" and "c"`. */
function listed(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * AV-1014. One pick or drop may hold one video and one activity. Two or more
 * of one kind are all refused, since there is no saying which was meant, and
 * the other kind in the same drop is still taken; a file that is neither is
 * named in the refusal.
 */
export function sortOverlayFiles(classified: readonly ClassifiedOverlayFile[]): SortedOverlayFiles {
  const videos = classified.filter((entry) => entry.kind === 'video').map((entry) => entry.file);
  const activities = classified
    .filter((entry) => entry.kind === 'activity')
    .map((entry) => entry.file);
  const neither = classified.filter((entry) => entry.kind === undefined).map((entry) => entry.file);
  const reasons: string[] = [];

  const one = (files: File[], noun: string, plural: string) => {
    if (files.length < 2) return files[0];
    reasons.push(
      `Choose one ${noun} at a time: ${listed(quoted(files))} are ${files.length === 2 ? 'both' : 'all'} ${plural}.`,
    );
    return undefined;
  };
  const video = one(videos, 'video', 'videos');
  const activity = one(activities, 'activity', 'activities');
  if (neither.length > 0) {
    reasons.push(
      `${listed(quoted(neither))} ${neither.length === 1 ? 'is' : 'are'} neither a video nor an activity. Choose an MP4 or MOV video, or a GPX, FIT, TCX or KML activity.`,
    );
  }
  return { video, activity, refusal: reasons.length > 0 ? reasons.join(' ') : undefined };
}
