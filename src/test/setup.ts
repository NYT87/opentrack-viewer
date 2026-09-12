import '@testing-library/jest-dom/vitest';

/*
 * jsdom has not implemented `Blob.stream()`, which every browser has. The GoPro
 * extractor reads a video through it precisely so a multi-gigabyte file is
 * never held in memory (`AV-903`), so without this the real extraction path
 * cannot be tested at all — only mocked, which would prove nothing about it.
 *
 * This is a shim for a standard API the environment is missing, not a stand-in
 * for anything under test: the library still does its own reading, chunking and
 * parsing. A browser supplies the real thing, and `AV-906` exercises it there.
 */
if (typeof Blob.prototype.stream !== 'function') {
  Object.defineProperty(Blob.prototype, 'stream', {
    configurable: true,
    writable: true,
    value(this: Blob): ReadableStream<Uint8Array> {
      const bytes = this.arrayBuffer();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(await bytes));
          controller.close();
        },
      });
    },
  });
}
