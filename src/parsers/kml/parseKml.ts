import {
  computeStreams,
  isPlausibleSpeed,
  toValidCoordinate,
  type Activity,
  type ActivityPoint,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';
import { withDerivedStats } from '../../domain/stats';
import type { KmlFeatureTally, RawKmlDocument, RawKmlPoint, RawKmlSegment } from './kmlTypes';

export const KML_PARSER_VERSION = '1.0.0';

export interface ParseKmlOptions {
  fileName?: string;
  fileSizeBytes?: number;
  /** Injectable so tests can run without a DOM-provided DOMParser. */
  domParser?: DOMParser;
  /** Overridable for deterministic ids in tests. */
  idFactory?: () => string;
}

/**
 * Namespaces a KML root is expected to declare. Lookups below are by local
 * name, as they are for GPX and TCX, so an unlisted namespace is a note to
 * the reader rather than a refusal: the elements still have to be KML's.
 */
const KML_NAMESPACES = new Set([
  'http://www.opengis.net/kml/2.2',
  'http://www.opengis.net/kml/2.3',
  'http://earth.google.com/kml/2.0',
  'http://earth.google.com/kml/2.1',
  'http://earth.google.com/kml/2.2',
]);

/**
 * A description is kept as a label, not a document: enough to recognize the
 * file, never enough to carry the HTML a KML description is allowed to hold.
 */
const MAX_DESCRIPTION_CHARS = 500;

/** `Folder` inside `Folder` is legal without limit; this app's patience is not. */
const MAX_CONTAINER_DEPTH = 32;

/**
 * AV-761. Parses a KML document into the normalized Activity model, so a KML
 * route is indistinguishable downstream from a GPX, FIT or TCX one (TD-002,
 * TD-033). The mapping is TD-037.
 *
 * Runs entirely in the browser via `DOMParser`, like the other XML formats:
 * the text never leaves the device. A KML file can point at the network in
 * several places — `NetworkLink`, icons, overlays, models — and every one of
 * them is counted and left alone. Nothing here, and nothing the result feeds,
 * requests a URL found in the file.
 *
 * Malformed *tuples* are skipped with warnings; only a document that cannot be
 * read as KML at all, or one with no route in it, is a hard failure (plan §15).
 */
export function parseKml(xml: string, options: ParseKmlOptions = {}): Activity {
  const warnings: ActivityWarning[] = [];
  const document = parseDocument(xml, warnings, options.domParser);
  const raw = readKmlDocument(document);

  if (raw.segments.length === 0) {
    throw new ActivityError('no_route_points', describeEmptyDocument(raw.tally));
  }

  const points = normalizePoints(raw.segments, warnings);
  // A timed track whose every sample lacks a fix is a clock, not a route:
  // there is nothing to draw, measure or export as geometry.
  if (!points.some((point) => point.lat !== undefined)) {
    throw new ActivityError('no_route_points', describeEmptyDocument(raw.tally, points.length));
  }
  reportFeatures(raw.tally, raw.segments.length, warnings);

  const activity: Activity = {
    id: (options.idFactory ?? defaultId)(),
    source: {
      format: 'kml',
      fileName: options.fileName,
      fileSizeBytes: options.fileSizeBytes,
      parserVersion: KML_PARSER_VERSION,
    },
    metadata: {
      name: chooseName(raw) ?? options.fileName?.replace(/\.kml$/i, ''),
      description: raw.description,
      // KML has no notion of sport: it describes a place, not a workout.
      // `unknown` is what an untyped GPX gets, and what lets the viewer offer
      // the speed/pace choice rather than assuming one (AV-908).
      sport: 'unknown',
    },
    points,
    streams: computeStreams(points),
    warnings,
  };

  const withStats = withDerivedStats(activity);
  withStats.metadata.startTime = withStats.derived?.startTime;
  withStats.metadata.endTime = withStats.derived?.endTime;
  return withStats;
}

/** Convenience wrapper matching the async parser contract used by intake. */
export async function parseKmlFile(file: File): Promise<Activity> {
  const text = await file.text();
  return parseKml(text, { fileName: file.name, fileSizeBytes: file.size });
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `activity-${Date.now()}`;
}

function parseDocument(xml: string, warnings: ActivityWarning[], injected?: DOMParser): Document {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new ActivityError('invalid_kml_xml', 'The file is empty.');
  }

  /*
   * A DTD is refused before the parser sees it. KML never needs one, and an
   * internal subset is where entity expansion lives: `DOMParser` honours
   * `<!ENTITY>` declarations, so a document could inflate itself by orders of
   * magnitude, or substitute text into a name, before a single element is
   * read. Checked on the text rather than on `document.doctype` because the
   * expansion has already happened by the time there is a document to ask.
   */
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new ActivityError(
      'invalid_kml_xml',
      'The file declares a DTD or entities, which a KML document never needs, so it was not read.',
    );
  }

  const parser = injected ?? new DOMParser();
  const document = parser.parseFromString(xml, 'application/xml');

  // DOMParser reports XML errors as a <parsererror> element rather than throwing.
  if (document.getElementsByTagName('parsererror').length > 0 || document.doctype) {
    throw new ActivityError('invalid_kml_xml', 'The file is not well-formed XML.');
  }
  const root = document.documentElement;
  if (!root || localName(root) !== 'kml') {
    throw new ActivityError('invalid_kml_xml', 'The document root is not <kml>.');
  }
  if (root.namespaceURI && !KML_NAMESPACES.has(root.namespaceURI)) {
    warnings.push({
      code: 'kml_unknown_namespace',
      message:
        'The document declares a KML namespace this app does not recognize. It was read as ' +
        'KML 2.2, which is what its elements look like.',
      severity: 'info',
    });
  }
  return document;
}

function emptyTally(): KmlFeatureTally {
  return {
    pointPlacemarks: 0,
    embeddedPoints: 0,
    polygons: 0,
    models: 0,
    overlays: 0,
    tours: 0,
    networkLinks: 0,
    styles: 0,
    externalLinks: 0,
    datedRoutes: 0,
    invalidTuples: 0,
    trackMismatch: 0,
    arrayMismatch: 0,
    deepContainers: 0,
    deepPlacemarks: 0,
  };
}

function readKmlDocument(document: Document): RawKmlDocument {
  const raw: RawKmlDocument = {
    placemarkNames: [],
    segments: [],
    tally: emptyTally(),
  };

  // Every <href> in the file, wherever it sits: a NetworkLink, an icon in a
  // style, an overlay image, a model. Counted so the reader is told the file
  // pointed somewhere, and so a test can assert nowhere was followed.
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (localName(element) === 'href' && text(element)) raw.tally.externalLinks += 1;
  }

  walkContainer(document.documentElement, raw, 0);
  return raw;
}

/**
 * `kml`, `Document` and `Folder` all hold features; a `Document` may also
 * name itself. Walked in document order, so placemarks become segments in the
 * order the file states them, whatever folders they sit in.
 *
 * A container past the depth limit is not entered, but it is not forgotten
 * either: whatever it holds is counted, so the reader is told that part of the
 * file was left out rather than handed a shorter route as if it were whole.
 */
function walkContainer(container: Element, raw: RawKmlDocument, depth: number): void {
  for (const element of Array.from(container.children)) {
    switch (localName(element)) {
      case 'document':
        if (raw.documentName === undefined) raw.documentName = text(child(element, 'name'));
        enterContainer(element, raw, depth + 1);
        break;
      case 'folder':
        enterContainer(element, raw, depth + 1);
        break;
      case 'placemark':
        readPlacemark(element, raw);
        break;
      case 'networklink':
        raw.tally.networkLinks += 1;
        break;
      case 'groundoverlay':
      case 'screenoverlay':
      case 'photooverlay':
        raw.tally.overlays += 1;
        break;
      case 'tour':
        raw.tally.tours += 1;
        break;
      case 'style':
      case 'stylemap':
      case 'schema':
        raw.tally.styles += 1;
        break;
      default:
        // name, description, visibility, LookAt, Camera, Region, ExtendedData…
        // none of it is a route, and none of it is lost by being left alone.
        break;
    }
  }
}

function enterContainer(element: Element, raw: RawKmlDocument, depth: number): void {
  if (depth <= MAX_CONTAINER_DEPTH) {
    walkContainer(element, raw, depth);
    return;
  }
  raw.tally.deepContainers += 1;
  for (const descendant of Array.from(element.getElementsByTagName('*'))) {
    if (localName(descendant) === 'placemark') raw.tally.deepPlacemarks += 1;
  }
}

function readPlacemark(placemark: Element, raw: RawKmlDocument): void {
  const before = raw.segments.length;
  let sawPoint = false;

  for (const element of Array.from(placemark.children)) {
    const kind = localName(element);
    if (kind === 'point') {
      sawPoint = true;
      continue;
    }
    if (kind === 'style' || kind === 'stylemap') {
      raw.tally.styles += 1;
      continue;
    }
    readGeometry(element, raw);
  }

  const contributed = raw.segments.length > before;

  if (!contributed) {
    // A placemark with a Point and nothing else is the waypoint case TD-037
    // declines: counted and said, not drawn.
    if (sawPoint) raw.tally.pointPlacemarks += 1;
    return;
  }

  if (sawPoint) raw.tally.embeddedPoints += 1;

  // A TimeStamp or TimeSpan dates the *feature*. Applying it to every vertex
  // would be inventing a clock the file does not have, so a LineString stays
  // untimed; a gx:Track carries its own `<when>` and ignores this anyway.
  const dated = Boolean(child(placemark, 'timestamp') ?? child(placemark, 'timespan'));
  const untimed = raw.segments
    .slice(before)
    .every((segment) => segment.points.every((point) => !point.time));
  if (dated && untimed) raw.tally.datedRoutes += 1;

  const name = text(child(placemark, 'name'));
  if (name) raw.placemarkNames.push(name);
  if (raw.description === undefined) {
    raw.description = plainDescription(child(placemark, 'description'));
  }
}

/** Reads one geometry element, appending any route segments it holds. */
function readGeometry(element: Element, raw: RawKmlDocument): void {
  switch (localName(element)) {
    case 'linestring':
      pushSegment(raw, readLineString(element, raw.tally));
      break;
    case 'track':
      pushSegment(raw, readTrack(element, raw.tally));
      break;
    case 'multitrack':
      // gx:interpolate says whether to draw across the gaps between tracks.
      // This app never does — a gap is a gap — so the flag has nothing to say.
      for (const track of children(element, 'track')) pushSegment(raw, readTrack(track, raw.tally));
      break;
    case 'multigeometry':
      for (const member of Array.from(element.children)) {
        if (localName(member) === 'point') raw.tally.embeddedPoints += 1;
        else readGeometry(member, raw);
      }
      break;
    case 'polygon':
    case 'linearring':
      raw.tally.polygons += 1;
      break;
    case 'model':
      raw.tally.models += 1;
      break;
    default:
      break;
  }
}

/** A geometry with no usable vertex is not a segment; it is a tally entry. */
function pushSegment(raw: RawKmlDocument, segment: RawKmlSegment): void {
  if (segment.points.length > 0) raw.segments.push(segment);
}

/**
 * `<coordinates>` holds whitespace-separated tuples of `lon,lat[,alt]` —
 * longitude first, the reverse of every other format this app reads. A tuple
 * with fewer than two numbers, or a non-finite one, is counted and skipped.
 *
 * `altitudeMode` is not consulted. It tells a globe how to *drape* the line —
 * on the ground, or at the stated height — not what was measured, and a track
 * exported from a device states its altitudes whichever mode it then chose.
 */
function readLineString(element: Element, tally: KmlFeatureTally): RawKmlSegment {
  const points: RawKmlPoint[] = [];
  const tuples = (text(child(element, 'coordinates')) ?? '').split(/\s+/).filter(Boolean);

  for (const tuple of tuples) {
    const point = readTuple(tuple);
    if (point) points.push(point);
    else tally.invalidTuples += 1;
  }

  return { points };
}

/**
 * A `gx:Track` lists its clock and its positions as two parallel arrays:
 * `<when>` children and `<gx:coord>` children, matched by position. A
 * `<gx:coord>` is space-separated rather than comma-separated, and may be
 * empty where the device had a time but no fix.
 *
 * Sensor readings ride alongside in `ExtendedData/SchemaData/gx:SimpleArrayData`,
 * one `<gx:value>` per sample under a name the writer chose. The common names
 * are mapped; anything else is left where it was.
 */
function readTrack(element: Element, tally: KmlFeatureTally): RawKmlSegment {
  const whens = children(element, 'when').map((node) => parseDate(text(node)));
  const coords = children(element, 'coord');
  const count = Math.min(whens.length, coords.length);

  if (whens.length !== coords.length) {
    tally.invalidTuples += Math.abs(whens.length - coords.length);
    tally.trackMismatch += 1;
  }

  const arrays = readSimpleArrays(element, count, tally);
  const points: RawKmlPoint[] = [];

  for (let i = 0; i < count; i += 1) {
    const time = whens[i];
    const tuple = text(coords[i]);
    const position = tuple ? readTuple(tuple, /\s+/) : undefined;

    if (tuple && !position) {
      tally.invalidTuples += 1;
      continue;
    }
    // A sample with neither a clock nor a place carries nothing usable.
    if (!time && !position) {
      tally.invalidTuples += 1;
      continue;
    }

    const point: RawKmlPoint = { ...position };
    if (time) point.time = time;
    for (const [field, values] of arrays) {
      const value = values[i];
      if (value !== undefined) point[field] = value;
    }
    points.push(point);
  }

  return { points };
}

type SensorField = Exclude<keyof RawKmlPoint, 'lat' | 'lon' | 'elevationMeters' | 'time'>;

/** Names writers give the arrays, lowercased. Google Earth and Garmin agree on these. */
const SENSOR_ARRAY_NAMES: Record<string, SensorField> = {
  heartrate: 'heartRateBpm',
  heart_rate: 'heartRateBpm',
  hr: 'heartRateBpm',
  cadence: 'cadence',
  power: 'powerWatts',
  watts: 'powerWatts',
  speed: 'speedMetersPerSecond',
  temperature: 'temperatureCelsius',
  temp: 'temperatureCelsius',
};

function readSimpleArrays(
  track: Element,
  sampleCount: number,
  tally: KmlFeatureTally,
): Map<SensorField, (number | undefined)[]> {
  const arrays = new Map<SensorField, (number | undefined)[]>();
  const extended = child(track, 'extendeddata');
  if (!extended) return arrays;

  for (const schemaData of children(extended, 'schemadata')) {
    for (const array of children(schemaData, 'simplearraydata')) {
      const field = SENSOR_ARRAY_NAMES[(array.getAttribute('name') ?? '').toLowerCase()];
      if (!field || arrays.has(field)) continue;

      const values = children(array, 'value').map((node) => parseNumber(text(node)));
      if (values.length !== sampleCount) tally.arrayMismatch += 1;
      arrays.set(field, values);
    }
  }

  return arrays;
}

/**
 * One `lon,lat[,alt]` tuple (or, for a `gx:coord`, `lon lat [alt]`). Returns
 * `undefined` for anything that is not a place: too few numbers, a non-finite
 * one, out of range, or Null Island — the same test every other parser applies.
 */
function readTuple(tuple: string, separator: RegExp | string = ','): RawKmlPoint | undefined {
  const parts = tuple.trim().split(separator);
  if (parts.length < 2) return undefined;

  const lon = parseNumber(parts[0]);
  const lat = parseNumber(parts[1]);
  const located = toValidCoordinate(lat, lon);
  if (!located) return undefined;

  const point: RawKmlPoint = { lat: located.lat, lon: located.lon };
  const altitude = parts.length > 2 ? parseNumber(parts[2]) : undefined;
  if (altitude !== undefined) point.elevationMeters = altitude;
  return point;
}

/**
 * The activity's name. A single route placemark names the activity, as a GPX
 * `<trk>` does. Several placemarks are one activity with several segments, so
 * the document's own name — the file's title — fits better than the first
 * segment's, and is what Google Earth shows at the top of the tree.
 */
function chooseName(raw: RawKmlDocument): string | undefined {
  if (raw.segments.length === 1 || raw.placemarkNames.length === 1) {
    return raw.placemarkNames[0] ?? raw.documentName;
  }
  return raw.documentName ?? raw.placemarkNames[0];
}

/**
 * A KML description may be HTML, and Google Earth renders it as such — a
 * balloon with images, links and scripts. This app renders text. The markup
 * is removed, never interpreted, and whatever text remains is cut to a label.
 *
 * The markup arrives in one of two shapes. Inside CDATA it is literal text,
 * and `textContent` hands it back as tags to strip. Written as XML it is
 * already elements, and `textContent` would keep a script's body while
 * dropping its tags; so those elements are removed from a copy first.
 */
function plainDescription(element: Element | undefined): string | undefined {
  if (!element) return undefined;

  const copy = element.cloneNode(true) as Element;
  for (const node of Array.from(copy.querySelectorAll('*'))) {
    const name = localName(node);
    if (name === 'script' || name === 'style') node.remove();
  }

  const raw = copy.textContent;
  if (!raw) return undefined;

  const stripped = raw
    // A script or style block is code, not words: its body goes with its tags.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return undefined;

  return stripped.length > MAX_DESCRIPTION_CHARS
    ? `${stripped.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : stripped;
}

/**
 * Assigns stable indices and segment boundaries. Each `LineString` or
 * `gx:Track` is a segment of its own: distance is not accumulated across the
 * boundary and no line is drawn over it, exactly as with a GPX `<trkseg>`.
 *
 * Cadence from a `gx:SimpleArrayData` has no unit, as in GPX, and KML states
 * no sport to decide one. The GPX rule for an untyped file applies: foot
 * cadence, because a step count is the overwhelmingly likely meaning.
 */
function normalizePoints(segments: RawKmlSegment[], warnings: ActivityWarning[]): ActivityPoint[] {
  const points: ActivityPoint[] = [];
  let missingCoordinates = 0;
  let missingElevation = 0;
  let missingTime = 0;

  segments.forEach((segment, segmentIndex) => {
    for (const item of segment.points) {
      const located = toValidCoordinate(item.lat, item.lon);
      if (!located) missingCoordinates += 1;
      if (!Number.isFinite(item.elevationMeters)) missingElevation += 1;
      if (!item.time) missingTime += 1;

      const point: ActivityPoint = { index: points.length, segmentIndex };
      if (located) {
        point.lat = located.lat;
        point.lon = located.lon;
      }
      if (Number.isFinite(item.elevationMeters)) point.elevationMeters = item.elevationMeters;
      if (item.time) point.time = item.time;
      if (Number.isFinite(item.heartRateBpm)) point.heartRateBpm = item.heartRateBpm;
      if (Number.isFinite(item.cadence)) point.runningCadenceSpm = item.cadence;
      if (Number.isFinite(item.powerWatts)) point.powerWatts = item.powerWatts;
      if (Number.isFinite(item.temperatureCelsius)) {
        point.temperatureCelsius = item.temperatureCelsius;
      }
      if (isPlausibleSpeed(item.speedMetersPerSecond)) {
        point.speedMetersPerSecond = item.speedMetersPerSecond;
      }
      points.push(point);
    }
  });

  if (missingCoordinates > 0) {
    warnings.push({
      code: 'points_missing_coordinates',
      message: `${missingCoordinates} of ${points.length} points had no usable coordinates and are not drawn.`,
      severity: missingCoordinates === points.length ? 'warning' : 'info',
    });
  }
  if (missingElevation === points.length) {
    warnings.push({
      code: 'no_elevation_data',
      message: 'No elevation values were present in this file.',
      severity: 'info',
    });
  }
  if (missingTime === points.length) {
    warnings.push({
      code: 'no_time_data',
      message:
        'No timestamps were present in this file: it holds a route, not a recording. ' +
        'Formats that need a clock cannot be written from it.',
      severity: 'info',
    });
  }

  return points;
}

/**
 * AV-762. What the file held that the activity does not, said once each.
 *
 * Geometry and features that could have been data are `warning`s, so the
 * viewer lists them beside the route before any export; presentation —
 * styles, icons, links — is `info`, because nothing an activity could carry
 * was lost with it.
 */
function reportFeatures(tally: KmlFeatureTally, segmentCount: number, warnings: ActivityWarning[]): void {
  if (segmentCount > 1) {
    warnings.push({
      code: 'multiple_segments',
      message:
        `This file has ${segmentCount} routes or tracks. Each is drawn as its own line, ` +
        'and the gaps between them are not counted towards the distance.',
      severity: 'info',
    });
  }

  if (tally.invalidTuples > 0) {
    warnings.push({
      code: 'kml_invalid_coordinates',
      message: `${plural(tally.invalidTuples, 'coordinate')} could not be read as a place and ${tally.invalidTuples === 1 ? 'was' : 'were'} skipped.`,
      severity: 'warning',
    });
  }
  if (tally.trackMismatch > 0) {
    warnings.push({
      code: 'kml_track_count_mismatch',
      message:
        `${plural(tally.trackMismatch, 'track')} listed a different number of times and positions. ` +
        'The pairs that line up were kept; the rest were skipped rather than guessed at.',
      severity: 'warning',
    });
  }
  if (tally.arrayMismatch > 0) {
    warnings.push({
      code: 'kml_sensor_count_mismatch',
      message:
        `${plural(tally.arrayMismatch, 'sensor stream')} had a different number of samples than the track. ` +
        'Values were matched by position, and samples beyond the track were dropped.',
      severity: 'warning',
    });
  }
  if (tally.datedRoutes > 0) {
    warnings.push({
      code: 'kml_placemark_time_ignored',
      message:
        `${plural(tally.datedRoutes, 'route')} carried a date on the placemark rather than a time per ` +
        'point. One date cannot time a track, so the route was read without timestamps.',
      severity: 'info',
    });
  }

  if (tally.deepContainers > 0) {
    warnings.push({
      code: 'kml_nesting_too_deep',
      message: `${describeDeepContent(tally)} The route shown may be incomplete.`,
      severity: 'warning',
    });
  }

  const points = tally.pointPlacemarks + tally.embeddedPoints;
  if (points > 0) {
    warnings.push({
      code: 'kml_points_not_read',
      message:
        `${plural(points, 'point placemark')} ${points === 1 ? 'was' : 'were'} not read. ` +
        'A point is a place, not part of a route, and this app has no waypoint model to keep it in.',
      severity: 'warning',
    });
  }

  const unsupported: string[] = [];
  if (tally.polygons > 0) unsupported.push(plural(tally.polygons, 'polygon'));
  if (tally.overlays > 0) unsupported.push(plural(tally.overlays, 'image overlay'));
  if (tally.models > 0) unsupported.push(plural(tally.models, '3D model'));
  if (tally.tours > 0) unsupported.push(plural(tally.tours, 'tour'));
  if (tally.networkLinks > 0) unsupported.push(plural(tally.networkLinks, 'network link'));
  if (unsupported.length > 0) {
    warnings.push({
      code: 'kml_unsupported_features',
      message:
        `Not read: ${joinList(unsupported)}. Only routes (LineString) and tracks (gx:Track) ` +
        'become activity data, and nothing else in the file can be written to another format.',
      severity: 'warning',
    });
  }

  if (tally.externalLinks > 0) {
    warnings.push({
      code: 'kml_external_links_not_fetched',
      message:
        `The file points at ${plural(tally.externalLinks, 'external resource')} (links, icons, ` +
        'images or models). None were requested: this app never follows a URL found in a file.',
      severity: 'info',
    });
  }
  if (tally.styles > 0) {
    warnings.push({
      code: 'kml_styles_ignored',
      message:
        'Line colours, widths, icons and other styling describe how a globe should draw the ' +
        'file, not what was recorded, so they are not carried into the activity.',
      severity: 'info',
    });
  }
}

/** Why a file with no route is being turned away, naming what it did hold. */
function describeEmptyDocument(tally: KmlFeatureTally, unlocatedSamples = 0): string {
  const held: string[] = [];
  const points = tally.pointPlacemarks + tally.embeddedPoints;
  if (points > 0) held.push(plural(points, 'point placemark'));
  if (tally.polygons > 0) held.push(plural(tally.polygons, 'polygon'));
  if (tally.overlays > 0) held.push(plural(tally.overlays, 'image overlay'));
  if (tally.models > 0) held.push(plural(tally.models, '3D model'));
  if (tally.networkLinks > 0) held.push(plural(tally.networkLinks, 'network link'));
  if (tally.invalidTuples > 0) held.push(plural(tally.invalidTuples, 'unreadable coordinate'));

  let base = 'No route was found: the file has no <LineString> or <gx:Track> with usable coordinates.';
  if (unlocatedSamples > 0) {
    base += ` Its ${plural(unlocatedSamples, 'timed sample')} carry no position.`;
  }
  if (tally.deepContainers > 0) base += ` ${describeDeepContent(tally)}`;
  return held.length > 0 ? `${base} It holds ${joinList(held)}, which this app does not read.` : base;
}

/** What sat below the folder depth limit and was therefore never read. */
function describeDeepContent(tally: KmlFeatureTally): string {
  const inside =
    tally.deepPlacemarks > 0
      ? `holding ${plural(tally.deepPlacemarks, 'placemark')}`
      : 'holding no placemarks';
  return (
    `${plural(tally.deepContainers, 'folder')} nested more than ${MAX_CONTAINER_DEPTH} levels deep, ` +
    `${inside}, ${tally.deepContainers === 1 ? 'was' : 'were'} not read.`
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/* Namespace-agnostic lookups: `gx:` is a prefix in one file and a default
 * namespace in another, and legacy files declare no namespace at all. */

function localName(element: Element): string {
  return (element.localName || element.nodeName).toLowerCase().replace(/^.*:/, '');
}

function children(parent: Element | undefined, name: string): Element[] {
  if (!parent) return [];
  return Array.from(parent.children).filter((entry) => localName(entry) === name);
}

function child(parent: Element | undefined, name: string): Element | undefined {
  return children(parent, name)[0];
}

function text(element: Element | undefined): string | undefined {
  const value = element?.textContent?.trim();
  return value ? value : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
