import { useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import {
  isProjectFor,
  parseMapVideoProject,
  referenceActivity,
  serializeMapVideoProject,
  type MapVideoSettings,
} from '../mapVideo/project';
import { download } from './ExportPanel';

export interface MapVideoProjectFileProps {
  activity: Activity;
  settings: MapVideoSettings;
  onOpen: (settings: MapVideoSettings) => void;
}

type Outcome = { kind: 'saved' } | { kind: 'opened'; notes: string[] } | { kind: 'refused'; fileName: string; error: string };

/**
 * AV-1204 (TD-066). Saves the video's settings as a project file, and opens
 * one. The file holds the settings and the activity's file name and point
 * count, nothing of the activity itself, so it can be kept or shared without
 * the ride in it; opening one applies its settings to the activity open here,
 * and says when it was made for another.
 */
export function MapVideoProjectFile({ activity, settings, onOpen }: MapVideoProjectFileProps) {
  const input = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<Outcome>();

  const open = async (file: File) => {
    const parsed = parseMapVideoProject(await file.text());
    if (!parsed.ok) {
      setOutcome({ kind: 'refused', fileName: file.name, error: parsed.error });
      return;
    }
    const { project, warnings } = parsed;
    onOpen(project.settings);
    const notes = [...warnings];
    if (!isProjectFor(project, activity)) {
      notes.unshift(
        `This project was made for ${project.activity.fileName ?? 'another activity'} (${project.activity.points} points). Its settings are applied to this one.`,
      );
    }
    setOutcome({ kind: 'opened', notes });
  };

  return (
    <section className="prose map-video-project" aria-label="Project">
      <h3 className="prose__title">Project</h3>
      <p>
        Save these settings to use again, or open a project saved before. The file holds the settings and
        the activity’s file name, and nothing of the route.
      </p>
      <p className="overlay-slot__actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            const json = serializeMapVideoProject({ activity: referenceActivity(activity), settings });
            download(new Blob([json], { type: 'application/json' }), 'map-video-project.json');
            setOutcome({ kind: 'saved' });
          }}
        >
          Save project
        </button>
        <button type="button" className="button" onClick={() => input.current?.click()}>
          Open project
        </button>
      </p>
      <input
        ref={input}
        type="file"
        hidden
        accept=".json,application/json"
        data-testid="map-video-project-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void open(file);
        }}
      />
      {outcome?.kind === 'saved' && <p role="status">Saved as map-video-project.json.</p>}
      {outcome?.kind === 'opened' && (
        <div role="status">
          <p>Project opened.</p>
          {outcome.notes.length > 0 && (
            <ul className="map-video-project__notes">
              {outcome.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {outcome?.kind === 'refused' && (
        <p role="alert">
          Could not open {outcome.fileName}. {outcome.error}
        </p>
      )}
    </section>
  );
}
