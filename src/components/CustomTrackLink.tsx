import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Activity, ActivityPointRange } from '../domain/activity';
import { draftFromActivity } from '../domain/routeDraft';
import { ROUTES } from '../app/routes';
import { useRouteDraftStore } from '../state/routeDraftStore';

interface CustomTrackLinkProps {
  activity: Activity;
  /** The chart selection, when there is one. */
  selectedRange?: ActivityPointRange;
}

/**
 * AV-1103. Hands a copy of the open activity's route to Route Builder as a
 * planned track to edit. A copy: `draftFromActivity` reads the activity and
 * leaves it alone (TD-048), so what the viewer shows is what it showed before,
 * and is still there on the way back.
 *
 * The whole route is what goes unless the reader says the selected section is
 * what they want, as for the route overlay: a selection made for looking is
 * not taken as a choice about what to plan from. The draft is built up front
 * rather than on the click, so whether the button can be pressed, and why not,
 * is the model's own answer and not a second guess at it.
 *
 * Held in memory only, like every handoff (§5): nothing is stored or sent.
 */
export function CustomTrackLink({ activity, selectedRange }: CustomTrackLinkProps) {
  const id = useId();
  const navigate = useNavigate();
  const setDraft = useRouteDraftStore((state) => state.setDraft);
  const [wantsSection, setWantsSection] = useState(false);

  const whole = useMemo(() => draftFromActivity(activity), [activity]);
  const section = useMemo(
    () => (selectedRange ? draftFromActivity(activity, { range: selectedRange }) : undefined),
    [activity, selectedRange],
  );
  const sectionAvailable = section?.ok === true;

  // A section the reader asked for that is not there — the selection moved to
  // a stretch with no locations, or was cleared — is not quietly swapped for
  // the whole activity: the button is disabled until they choose again.
  const sectionLost = wantsSection && !sectionAvailable;

  const handOff = () => {
    const chosen = wantsSection && section?.ok ? section : whole;
    if (!chosen.ok) return;
    setDraft(chosen.value);
    navigate(ROUTES.routeBuilder);
  };

  return (
    <div className="export custom-track-link">
      <h2 className="export__title">Custom track</h2>
      <p className="export__body">
        Copies this route into Route Builder as a planned track you can edit and export for a
        device. The activity you are viewing stays as it is. Nothing is uploaded or stored.
      </p>
      {(sectionAvailable || wantsSection) && (
        <label className="export__choice" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={wantsSection}
            onChange={(event) => setWantsSection(event.target.checked)}
          />
          Copy only the selected section
        </label>
      )}
      <p>
        <button
          type="button"
          className="button"
          disabled={!whole.ok || sectionLost}
          onClick={handOff}
        >
          Create custom track
        </button>
      </p>
      {sectionLost && (
        <p className="export__note" role="status">
          The selected section has no usable locations, or is no longer selected. Select a
          stretch of the route, or untick the box to use the whole activity.
        </p>
      )}
      {!whole.ok && <p className="export__note">{whole.error.message}</p>}
    </div>
  );
}
