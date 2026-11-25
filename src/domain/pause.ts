/**
 * AV-1024 (TD-093). The one setting for "standing still": a speed threshold and
 * a minimum duration. Moving time (TD-058), the overlay's stops and auto-pause
 * gaps (TD-080) and its moving-so-far figures all read it here, so they cannot
 * disagree. The defaults are what each of them did before the setting existed:
 * a step is moving at 0.5 m/s or more, and a stop of any length is a stop.
 */
export interface PauseSettings {
  /** A step slower than this is standing still, in metres per second. */
  speedThresholdMps: number;
  /** A stop shorter than this is counted as moving, in seconds; 0 is every stop. */
  minStopSeconds: number;
}

/** A step is moving at or above this, as the stats count moving time (TD-058). */
export const MOVING_SPEED_THRESHOLD_MPS = 0.5;

export const DEFAULT_PAUSE_SETTINGS: PauseSettings = {
  speedThresholdMps: MOVING_SPEED_THRESHOLD_MPS,
  minStopSeconds: 0,
};

/** True when a step's speed is under the threshold (before the minimum duration is asked). */
export function isBelowPauseSpeed(speedMps: number, pause: PauseSettings): boolean {
  return speedMps < pause.speedThresholdMps;
}

/**
 * A single stretch of time with a known distance, such as a recording gap the
 * overlay asks about: stopped when it is slow *and* at least the minimum long.
 */
export function isStopped(meters: number, seconds: number, pause: PauseSettings): boolean {
  return isBelowPauseSpeed(meters / seconds, pause) && seconds >= pause.minStopSeconds;
}

export interface PauseStep {
  seconds: number;
  meters: number;
  /** The step does not follow the one before it: a new segment, or a point between with no distance. */
  breakBefore?: boolean;
}

/**
 * Which steps count as moving. A step is slow when it is under the speed
 * threshold; a run of consecutive slow steps is a stop only when the run lasts
 * the minimum duration, and a shorter one is counted as moving. A step of no
 * duration says nothing: it is not moving, and it neither starts nor ends a
 * run. With the default minimum of 0 this is exactly "moving at 0.5 m/s or
 * more" step by step, as it was before the setting.
 */
export function movingSteps(steps: readonly PauseStep[], pause: PauseSettings): boolean[] {
  const moving: boolean[] = new Array(steps.length).fill(false);
  let run: number[] = [];
  let runSeconds = 0;
  const closeRun = () => {
    if (runSeconds < pause.minStopSeconds) for (const k of run) moving[k] = true;
    run = [];
    runSeconds = 0;
  };
  steps.forEach((step, k) => {
    if (step.breakBefore) closeRun();
    if (!(step.seconds > 0)) return;
    if (isBelowPauseSpeed(step.meters / step.seconds, pause)) {
      run.push(k);
      runSeconds += step.seconds;
    } else {
      closeRun();
      moving[k] = true;
    }
  });
  closeRun();
  return moving;
}
