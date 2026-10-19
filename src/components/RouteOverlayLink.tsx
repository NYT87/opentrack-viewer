import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hasValidLocation, type Activity, type ActivityPointRange } from '../domain/activity';
import { sliceActivity } from '../domain/activitySlice';
import { ROUTES } from '../app/routes';
import { useOverlayStore } from '../state/overlayStore';

interface RouteOverlayLinkProps {
  activity: Activity;
  /** The chart selection, when there is one. */
  selectedRange?: ActivityPointRange;
}

/**
 * AV-1009. Hands the open activity to the overlay page, to be made into a
 * route image — on its own: a video held there from before is let go. The
 * whole activity is what goes unless the reader says the focused section is
 * what they want: a selection made for looking is not taken as a choice about
 * what to export.
 *
 * Held in memory only, like every handoff (§5): nothing is stored or sent.
 */
export function RouteOverlayLink({ activity, selectedRange }: RouteOverlayLinkProps) {
  const id = useId();
  const navigate = useNavigate();
  const setStandalone = useOverlayStore((state) => state.setStandaloneActivity);
  const [wantsSection, setWantsSection] = useState(false);

  // A single located fix is a route the image can draw (as a dot), so the
  // test is for any usable location, not for a line.
  const wholeRoute = activity.points.some(hasValidLocation);
  const slice = useMemo(
    () => (selectedRange ? sliceActivity(activity, selectedRange) : undefined),
    [activity, selectedRange],
  );
  const section = slice?.ok && slice.activity.points.some(hasValidLocation) ? slice.activity : undefined;

  // A section the reader asked for that is not there — the selection moved to
  // stretch with no locations, or was cleared — is not quietly swapped for the
  // whole activity: the button is disabled until they choose again.
  const sectionLost = wantsSection && !section;

  const handOff = () => {
    if (wantsSection && section) setStandalone(section, { focusedSection: true });
    else setStandalone(activity);
    navigate(ROUTES.overlays);
  };

  return (
    <div className="export route-overlay-link">
      <h2 className="export__title">Route overlay</h2>
      <p className="export__body">
        Makes the route into a transparent PNG for placing over a video or a design. It is drawn
        in this tab, with no map under it, and nothing is uploaded.
      </p>
      {(section || wantsSection) && (
        <label className="export__choice" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={wantsSection}
            onChange={(event) => setWantsSection(event.target.checked)}
          />
          Use only the selected section
        </label>
      )}
      <p>
        <button
          type="button"
          className="button"
          disabled={!wholeRoute || sectionLost}
          onClick={handOff}
        >
          Create route overlay
        </button>
      </p>
      {sectionLost && (
        <p className="export__note" role="status">
          The selected section has no usable locations, or is no longer selected. Select a
          stretch of the route, or untick the box to use the whole activity.
        </p>
      )}
      {!wholeRoute && (
        <p className="export__note">This activity has no route to draw: it has no usable locations.</p>
      )}
    </div>
  );
}
