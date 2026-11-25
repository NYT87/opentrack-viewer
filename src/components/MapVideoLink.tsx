import { useNavigate } from 'react-router-dom';
import type { Activity } from '../domain/activity';
import { ROUTES } from '../app/routes';
import { mapVideoRefusal, useMapVideoStore, type MapVideoActivityOrigin } from '../state/mapVideoStore';

interface MapVideoLinkProps {
  activity: Activity;
  origin: Exclude<MapVideoActivityOrigin, 'hand'>;
  className?: string;
}

/**
 * AV-1202. "Make a map video": hands the activity to the map video page, in
 * memory only (§5). An activity the page would refuse gets no button: the
 * places that show this already say when there is no route.
 */
export function MapVideoLink({ activity, origin, className = 'button' }: MapVideoLinkProps) {
  const navigate = useNavigate();
  const setActivity = useMapVideoStore((state) => state.setActivity);
  if (mapVideoRefusal(activity)) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        setActivity(activity, origin);
        navigate(ROUTES.mapVideo);
      }}
    >
      Make a map video
    </button>
  );
}
