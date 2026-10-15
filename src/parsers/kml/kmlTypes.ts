/**
 * AV-760. What the KML reader keeps from a document before normalization.
 *
 * A KML file is a *scene*, not a recording: it describes what to draw, where,
 * and in what colour. Only two of its geometries are a route — `LineString`
 * and the timed `gx:Track` — and everything else is counted here so it can be
 * reported, never read. The names say what this app refused, so the reader of
 * a warning knows what their file held that the activity does not.
 */

/** One vertex of a route or track, before validation. */
export interface RawKmlPoint {
  lat?: number;
  lon?: number;
  elevationMeters?: number;
  time?: Date;
  heartRateBpm?: number;
  cadence?: number;
  powerWatts?: number;
  speedMetersPerSecond?: number;
  temperatureCelsius?: number;
}

/** One `LineString` or one `gx:Track`: a continuous stretch of route. */
export interface RawKmlSegment {
  points: RawKmlPoint[];
}

/** What a document contained that is not a route, tallied for the warnings. */
export interface KmlFeatureTally {
  /** Placemarks whose only geometry is a `Point`. */
  pointPlacemarks: number;
  /** `Point` members found inside a `MultiGeometry` beside real route data. */
  embeddedPoints: number;
  polygons: number;
  models: number;
  overlays: number;
  tours: number;
  networkLinks: number;
  /** `Style`, `StyleMap` and `Schema` elements: presentation, not data. */
  styles: number;
  /** Non-empty `<href>` elements anywhere in the document. Never fetched. */
  externalLinks: number;
  /** Routes dated on the placemark rather than per vertex. */
  datedRoutes: number;
  /** Coordinate tuples that could not be read as a place. */
  invalidTuples: number;
  /** `gx:Track`s whose `<when>` and `<gx:coord>` counts differ. */
  trackMismatch: number;
  /** `gx:SimpleArrayData`s whose sample count differs from their track's. */
  arrayMismatch: number;
  /** `Folder`s and `Document`s nested past the walker's depth limit, not entered. */
  deepContainers: number;
  /** Placemarks inside those containers, whatever they held. Not read. */
  deepPlacemarks: number;
}

export interface RawKmlDocument {
  /** The `Document`'s own name, when it has one. */
  documentName?: string;
  /** Names of the placemarks that contributed route geometry, in order. */
  placemarkNames: string[];
  /** Plain-text description of the first route placemark, markup removed. */
  description?: string;
  segments: RawKmlSegment[];
  tally: KmlFeatureTally;
}
