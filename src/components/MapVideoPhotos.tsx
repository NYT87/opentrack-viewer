import { useId, useState } from 'react';
import { formatDistance, type UnitSystem } from '../domain/units';
import { PHOTO_LIMITS, type PhotoPlacement, type PhotoPlacementMethod, type PhotoSetting, type PhotosSettings } from '../mapVideo/photos';
import { PHOTO_EXTENSIONS, readPhotoFile, type MapVideoPhoto } from '../mapVideo/readPhoto';
import { formatVideoTime } from '../mapVideo/timing';
import { FileDropZone } from './FileDropZone';

const METHOD_LABELS: Record<PhotoPlacementMethod, string> = {
  time: 'By when it was taken',
  position: 'By where it was taken',
  hand: 'By hand',
};

const METERS_PER_MILE = 1609.344;

export interface MapVideoPhotosProps {
  photos: MapVideoPhoto[];
  placements: PhotoPlacement[];
  /** When each placed photo is shown, in video seconds. */
  shownAt: ReadonlyMap<string, number>;
  settings: PhotosSettings;
  onAdd: (photos: MapVideoPhoto[]) => void;
  onRemove: (id: string) => void;
  onChange: (patch: Partial<PhotosSettings>) => void;
  /** Where the marker is in the preview now, in metres along the route as recorded: where "Place at the marker" puts a photo. */
  markerMeters: number;
  routeMeters: number;
  units: UnitSystem;
  /** How a time with no zone is read, said beside the clock offset. */
  zoneNote: string;
  /** Why the photos are shown for less than asked, when they are. */
  holdNote?: string;
}

/**
 * AV-1208. The reader's photos: added from the device, each placed by when
 * or where it was taken or by hand, shown while the marker waits, and listed
 * with the reason when one cannot be placed. Nothing of their EXIF leaves the
 * tab or reaches a project or a video (TD-071).
 */
export function MapVideoPhotos(props: MapVideoPhotosProps) {
  const { photos, placements, shownAt, settings, onAdd, onRemove, onChange, markerMeters, routeMeters, units, zoneNote, holdNote } = props;
  const ids = { hold: useId(), offset: useId() };
  const [reading, setReading] = useState(0);
  const imperial = units === 'imperial';
  const unit = imperial ? 'mi' : 'km';
  const perUnit = imperial ? METERS_PER_MILE : 1000;

  const setItem = (name: string, patch: Partial<PhotoSetting>, method: PhotoPlacementMethod) => {
    const current = settings.items.find((item) => item.name === name);
    const item: PhotoSetting = { name, method, ...current, ...patch };
    onChange({ items: [...settings.items.filter((entry) => entry.name !== name), item] });
  };
  const add = async (files: File[]) => {
    setReading((count) => count + files.length);
    const read = await Promise.all(files.map(readPhotoFile));
    setReading((count) => count - files.length);
    onAdd(read);
  };
  const waiting = settings.items.filter((item) => !photos.some((photo) => photo.name === item.name));

  return (
    <section className="prose map-video-photos" aria-label="Photos">
      <h3 className="prose__title">Photos</h3>
      <p className="map-video-settings__hint">
        Add photos from this device. When the marker reaches one, it waits while the photo is shown over the map. Each
        is placed by when or where it was taken, which its own data says, or by hand. That data stays in this tab: it is
        not written into the video or a project file.
      </p>
      <FileDropZone acceptedExtensions={PHOTO_EXTENSIONS} onFiles={(files) => void add(files)} multiple testId="map-video-photo-input" />
      {reading > 0 && <p role="status">Reading {reading === 1 ? 'a photo' : `${reading} photos`} in this tab…</p>}

      {waiting.length > 0 && (
        <p className="map-video-settings__hint" role="status">
          The project names {waiting.length === 1 ? 'a photo' : 'photos'} not added yet: {waiting.map((item) => item.name).join(', ')}. Add{' '}
          {waiting.length === 1 ? 'it' : 'them'} again to place {waiting.length === 1 ? 'it' : 'them'} as before.
        </p>
      )}

      {photos.length > 0 && (
        <ul className="map-video-photos__list">
          {photos.map((photo) => {
            const placement = placements.find((entry) => entry.id === photo.id);
            const method = placement?.method ?? 'hand';
            const setting = settings.items.find((item) => item.name === photo.name);
            const at = shownAt.get(photo.id);
            return (
              <li key={photo.id} className="map-video-photo" aria-label={photo.name}>
                {photo.thumbnail ? <img className="map-video-photo__thumb" src={photo.thumbnail} alt="" /> : <span className="map-video-photo__thumb" />}
                <div className="map-video-photo__body">
                  <p className="map-video-photo__name">{photo.name}</p>
                  {!photo.decodeError && (
                    <label className="map-video-settings__field">
                      <span>Placed</span>
                      <select value={method} onChange={(event) => setItem(photo.name, { method: event.target.value as PhotoPlacementMethod }, method)}>
                        {(Object.keys(METHOD_LABELS) as PhotoPlacementMethod[]).map((value) => (
                          <option key={value} value={value}>
                            {METHOD_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {method === 'hand' && !photo.decodeError && (
                    <div className="map-video-photo__hand">
                      <button
                        type="button"
                        className="button"
                        onClick={() => setItem(photo.name, { method: 'hand', handMeters: markerMeters }, 'hand')}
                      >
                        Place at the marker
                      </button>
                      <label className="map-video-settings__field">
                        <span>Along the route</span>
                        <span className="map-video-settings__input">
                          <input
                            type="number"
                            min={0}
                            max={Number((routeMeters / perUnit).toFixed(2))}
                            step={0.01}
                            value={setting?.handMeters === undefined ? '' : Number((setting.handMeters / perUnit).toFixed(2))}
                            onChange={(event) => {
                              const value = event.target.valueAsNumber;
                              if (Number.isFinite(value)) setItem(photo.name, { method: 'hand', handMeters: Math.min(routeMeters, Math.max(0, value * perUnit)) }, 'hand');
                            }}
                          />
                          <span>{unit}</span>
                        </span>
                      </label>
                    </div>
                  )}
                  <p className="map-video-photo__status" role={placement?.reason ? 'status' : undefined}>
                    {placement?.reason
                      ? `Left out: ${placement.reason}`
                      : placement?.distance !== undefined
                        ? `Shown at ${formatVideoTime(at ?? 0)}, ${formatDistance(placement.distance, units)} along the route.`
                        : ''}
                  </p>
                </div>
                <button type="button" className="button" onClick={() => onRemove(photo.id)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="map-video-settings__field">
        <label htmlFor={ids.hold}>Each photo is shown for</label>
        <span className="map-video-settings__input">
          <input
            id={ids.hold}
            type="number"
            min={PHOTO_LIMITS.holdSeconds[0]}
            max={PHOTO_LIMITS.holdSeconds[1]}
            step={0.5}
            value={settings.holdSeconds}
            aria-describedby={`${ids.hold}-unit`}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              const [min, max] = PHOTO_LIMITS.holdSeconds;
              if (Number.isFinite(value)) onChange({ holdSeconds: Math.min(max, Math.max(min, value)) });
            }}
          />
          <span id={`${ids.hold}-unit`}>s</span>
        </span>
      </div>
      {holdNote && <p className="map-video-settings__hint" role="status">{holdNote}</p>}
      <div className="map-video-settings__field">
        <label htmlFor={ids.offset}>Camera clock ahead of the activity by</label>
        <span className="map-video-settings__input">
          <input
            id={ids.offset}
            type="number"
            step={1}
            value={settings.clockOffsetSeconds}
            aria-describedby={`${ids.offset}-note`}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              const [min, max] = PHOTO_LIMITS.clockOffsetSeconds;
              if (Number.isFinite(value)) onChange({ clockOffsetSeconds: Math.min(max, Math.max(min, Math.round(value))) });
            }}
          />
          <span>s</span>
        </span>
      </div>
      <p id={`${ids.offset}-note`} className="map-video-settings__hint">
        Negative when the camera was behind. {zoneNote}
      </p>
    </section>
  );
}
