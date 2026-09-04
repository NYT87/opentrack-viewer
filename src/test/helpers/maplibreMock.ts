import { vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

/**
 * Records the worker URL the component registers. MapLibre resolves its worker
 * from `import.meta.url` at runtime, so the app must override it explicitly or
 * GeoJSON sources silently never load.
 */
export const setWorkerUrl = vi.fn();

/** A minimal MapLibre stand-in: jsdom has no WebGL, so the real Map cannot run. */
export class FakeMap {
  static instances: FakeMap[] = [];

  readonly options: Record<string, unknown>;
  readonly sources = new Map<string, { data: unknown; setData: (data: unknown) => void }>();
  readonly layers: Record<string, unknown>[] = [];
  readonly fitBoundsCalls: unknown[][] = [];
  readonly easeToCalls: unknown[] = [];
  readonly styles: unknown[] = [];
  readonly layoutProperties: Record<string, unknown> = {};
  readonly paintProperties: Record<string, unknown> = {};
  setStyleCalls = 0;
  removed = false;

  private listeners: { event: string; layer?: string; handler: Listener }[] = [];
  private styleLoaded = false;
  private hasLoadedOnce = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.styles.push(options.style);
    FakeMap.instances.push(this);
  }

  addControl(): this {
    return this;
  }

  on(event: string, layerOrHandler: string | Listener, maybeHandler?: Listener): this {
    if (typeof layerOrHandler === 'function') {
      this.listeners.push({ event, handler: layerOrHandler });
    } else if (maybeHandler) {
      this.listeners.push({ event, layer: layerOrHandler, handler: maybeHandler });
    }
    return this;
  }

  off(event: string, layerOrHandler: string | Listener, maybeHandler?: Listener): this {
    const handler = typeof layerOrHandler === 'function' ? layerOrHandler : maybeHandler;
    this.listeners = this.listeners.filter(
      (entry) => !(entry.event === event && entry.handler === handler),
    );
    return this;
  }

  /** Drives handlers the component registered, as the real map would. */
  emit(event: string, payload?: unknown, layer?: string): void {
    for (const entry of this.listeners) {
      if (entry.event !== event) continue;
      if (layer !== undefined && entry.layer !== layer) continue;
      entry.handler(payload);
    }
  }

  isStyleLoaded(): boolean {
    return this.styleLoaded;
  }

  loaded(): boolean {
    return this.styleLoaded;
  }

  /**
   * Simulates the style finishing its load. The real map fires `load` for the
   * first style and `style.load` after every setStyle; the component installs
   * its sources on both.
   */
  completeStyleLoad(): void {
    const isFirst = !this.hasLoadedOnce;
    this.hasLoadedOnce = true;
    this.styleLoaded = true;
    this.emit(isFirst ? 'load' : 'style.load');
  }

  setStyle(style: unknown): void {
    this.setStyleCalls += 1;
    this.styles.push(style);
    this.styleLoaded = false;
    this.sources.clear();
    this.layers.length = 0;
  }

  addSource(id: string, source: { data: unknown }): void {
    const entry = {
      data: source.data,
      setData: (data: unknown) => {
        entry.data = data;
      },
    };
    this.sources.set(id, entry);
  }

  /** Layers come from the applied style as well as from addLayer. */
  getLayer(id: string) {
    const added = this.layers.find((layer) => layer.id === id);
    if (added) return added;
    const style = this.styles[this.styles.length - 1] as
      | { layers?: Record<string, unknown>[] }
      | undefined;
    return style?.layers?.find((layer) => layer.id === id);
  }

  setLayoutProperty(id: string, name: string, value: unknown): void {
    if (name === 'visibility') this.layoutProperties[id] = value;
  }

  setPaintProperty(id: string, name: string, value: unknown): void {
    this.paintProperties[`${id}.${name}`] = value;
  }

  getSource(id: string) {
    return this.sources.get(id);
  }

  addLayer(layer: Record<string, unknown>): void {
    this.layers.push(layer);
  }

  fitBounds(...args: unknown[]): void {
    this.fitBoundsCalls.push(args);
  }

  easeTo(options: unknown): void {
    this.easeToCalls.push(options);
  }

  queryRenderedFeatures = vi.fn(() => [] as unknown[]);

  remove(): void {
    this.removed = true;
  }
}

export function resetMapLibreMock(): void {
  FakeMap.instances.length = 0;
}

export function latestMap(): FakeMap {
  const map = FakeMap.instances[FakeMap.instances.length - 1];
  if (!map) throw new Error('No map was created');
  return map;
}
