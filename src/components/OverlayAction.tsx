import { useNavigate } from 'react-router-dom';
import type { Activity, ActivityPointRange } from '../domain/activity';
import { sliceActivity } from '../domain/activitySlice';
import { ROUTES } from '../app/routes';
import { useOverlayStore } from '../state/overlayStore';

/**
 * AV-1009. Hands the open activity — or the section selected on the charts —
 * to the Overlays page. The activity itself is not changed and stays open.
 */
export function OverlayAction({
  activity,
  selectedRange,
}: {
  activity: Activity;
  selectedRange?: ActivityPointRange;
}) {
  const navigate = useNavigate();
  const setOverlayActivity = useOverlayStore((state) => state.setActivity);
  const canDraw = activity.streams.hasLocation;

  const open = () => {
    const sliced = selectedRange ? sliceActivity(activity, selectedRange) : undefined;
    if (sliced?.ok) setOverlayActivity(sliced.activity, { isSection: true });
    else setOverlayActivity(activity);
    navigate(ROUTES.overlays);
  };

  return (
    <div className="custom-track">
      <h3 className="prose__title">Make an overlay from this</h3>
      <p>
        Draw this route as a transparent image to lay over a video.
        {selectedRange ? ' The section selected on the charts is used.' : ''}
      </p>
      <button type="button" className="button" onClick={open} disabled={!canDraw}>
        Create route overlay
      </button>
      {!canDraw && <p role="note">This activity has no GPS coordinates, so there is no route to draw.</p>}
    </div>
  );
}
