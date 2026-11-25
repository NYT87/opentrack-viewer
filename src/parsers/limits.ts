import { ActivityError, type ActivityErrorCode } from '../domain/errors';

export const MAX_ACTIVITY_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ACTIVITY_POINTS = 250_000;
export const MAX_XML_DEPTH = 64;
export const MAX_XML_ELEMENTS = 2_000_000;

export function assertFileSize(size: number): void {
  if (!Number.isFinite(size) || size < 0 || size > MAX_ACTIVITY_FILE_BYTES) {
    throw new ActivityError('import_limit_exceeded', 'Activity files must be 32 MiB or smaller. Split this recording into smaller files before opening it.');
  }
}

export function assertPointCount(count: number): void {
  if (count > MAX_ACTIVITY_POINTS) {
    throw new ActivityError('import_limit_exceeded', 'This recording exceeds 250,000 points. Split or simplify it before opening it.');
  }
}

/** Check declarations before DOMParser can expand anything. */
export function assertXmlInput(xml: string, code: ActivityErrorCode): void {
  assertFileSize(xml.length);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new ActivityError(code, 'The file declares a DTD or entities, which are not supported. Export it without these declarations.');
  }
}

/** Iterative traversal bounds downstream recursive extension readers. */
export function assertXmlStructure(document: Document): void {
  let node: Element | null = document.documentElement;
  let depth = 1;
  let count = 0;
  while (node) {
    count += 1;
    if (depth > MAX_XML_DEPTH || count > MAX_XML_ELEMENTS) {
      throw new ActivityError('import_limit_exceeded', 'This XML document is too complex. Export a simpler activity file.');
    }
    if (node.firstElementChild) {
      node = node.firstElementChild;
      depth += 1;
      continue;
    }
    while (node && !node.nextElementSibling) {
      node = node.parentElement;
      depth -= 1;
    }
    node = node?.nextElementSibling ?? null;
  }
}
