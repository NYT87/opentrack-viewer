import { useNavigate } from 'react-router-dom';
import type { Activity } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { draftFromActivity } from '../domain/routeDraft';
import { ROUTES } from '../app/routes';
import { useRouteDraftStore } from '../state/routeDraftStore';

/**
 * AV-1103. Copies the open activity's route into Route Builder.
 *
 * The draft is built from the activity and put in memory; the activity itself
 * is not touched and stays open here, so coming back finds it as it was. When
 * there is no usable route the control is disabled and says why, rather than
 * disappearing and leaving the reader to wonder where it went.
 */
export function CustomTrackAction({ activity }: { activity: Activity }) {
  const navigate = useNavigate();
  const setDraft = useRouteDraftStore((state) => state.setDraft);
  const canSeed = activity.streams.hasLocation;

  const create = () => {
    try {
      setDraft(draftFromActivity(activity));
    } catch (error) {
      if (error instanceof ActivityError) return;
      throw error;
    }
    navigate(ROUTES.routeBuilder);
  };

  return (
    <div className="custom-track">
      <h3 className="prose__title">Plan a route from this</h3>
      <p>
        Make an editable copy of this route in Route Builder, to trim, extend and export for
        another device. This activity is left as it is.
      </p>
      <button type="button" className="button" onClick={create} disabled={!canSeed}>
        Create Custom Track
      </button>
      {!canSeed && (
        <p role="note">This activity has no GPS coordinates, so there is no route to copy.</p>
      )}
    </div>
  );
}
