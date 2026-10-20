/**
 * The maths behind the phone sheet's drag (apple-design; the apple-design skill §4–§9, from WWDC 2018 "Designing Fluid
 * Interfaces"). Pure functions, no DOM: sheet.tsx feeds them pointer samples and draws what they return.
 *
 * Units: positions in px (the sheet's offset down from open, so 0 is open and positive is lower), velocities in px/s,
 * times in ms for pointer samples and in s for springs.
 */

/** Apple's scroll-like deceleration rate (UIScrollView.DecelerationRate.normal). */
export const DECELERATION_RATE = 0.998;

/**
 * Where a gesture released at `velocity` would come to rest (skill §6, Apple's sample code): the exponential-decay
 * form, not the textbook v²/2a. 1,000 px/s projects about 499 px.
 */
export function project(velocity: number, decelerationRate: number = DECELERATION_RATE): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Rubber-banding past a bound (skill §9): the further past the edge, the less the sheet follows, and it never passes
 * `dimension`. Keeps the sign of `overshoot` (a drag above the open position is negative).
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** One pointer position: `t` is the event's timeStamp (ms), `y` its clientY (px). */
export interface Sample {
  readonly t: number;
  readonly y: number;
}

/** Only the last 80 ms of a drag count towards its release velocity: an older move is not where the finger is going. */
export const VELOCITY_WINDOW_MS = 80;

/**
 * The finger's velocity at release (px/s, positive = down) from its recent samples (skill §2: a short history, not the
 * last point). A finger that stopped before lifting (no sample in the window but the last) releases at 0.
 */
export function releaseVelocity(samples: readonly Sample[], releaseT: number, windowMs: number = VELOCITY_WINDOW_MS): number {
  const recent = samples.filter((s) => releaseT - s.t <= windowMs);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last === first) return 0;
  const dt = last.t - first.t;
  return dt > 0 ? ((last.y - first.y) / dt) * 1000 : 0;
}

/** A release at least this fast is a flick: its direction decides, wherever the sheet is (skill §5–6, Vaul's 0.4 px/ms). */
export const FLICK_VELOCITY = 400;

export type Release = "dismiss" | "settle";

/**
 * Close or settle back. A flick is decided by the sign of its velocity, not the position (skill quick reference: "use
 * velocity sign, not position"); a slow release goes to the snap point nearest where its momentum would carry it
 * (open at 0 or closed at `height`), so a long, slow drag past half closes and a short one springs back.
 */
export function decideRelease({ offset, velocity, height }: { offset: number; velocity: number; height: number }): Release {
  if (Math.abs(velocity) >= FLICK_VELOCITY) return velocity > 0 ? "dismiss" : "settle";
  return offset + project(velocity) > height / 2 ? "dismiss" : "settle";
}

/** A spring in Apple's two numbers (skill §4): damping ratio (1 = no bounce) and response (s; lower is snappier). */
export interface SpringParams {
  readonly damping: number;
  readonly response: number;
}

/** The default: critically damped, response 0.4 (the sheet coming up). */
export const SPRING_DEFAULT: SpringParams = { damping: 1, response: 0.4 };
/** Leaving without a gesture (Esc, the close button, the scrim): critically damped, response 0.3. */
export const SPRING_FAST: SpringParams = { damping: 1, response: 0.3 };
/** After a drag release, and only then: Apple's drawer spring, a little bounce because the gesture carried momentum. */
export const SPRING_DRAWER: SpringParams = { damping: 0.8, response: 0.3 };

export interface SpringState {
  readonly value: number;
  readonly velocity: number;
}

/**
 * The spring `t` seconds after it set off from `from` at `velocity` px/s towards `to` (closed form, so every frame is
 * exact and a new spring can start from any frame's value and velocity: skill §3, §5). Damping ≥ 1 is treated as
 * critical.
 */
export function springAt(t: number, from: number, to: number, velocity: number, { damping, response }: SpringParams): SpringState {
  const w0 = (2 * Math.PI) / response;
  const x0 = from - to;
  if (damping >= 1) {
    const c = velocity + w0 * x0;
    const decay = Math.exp(-w0 * t);
    return { value: to + (x0 + c * t) * decay, velocity: (c - w0 * (x0 + c * t)) * decay };
  }
  const wd = w0 * Math.sqrt(1 - damping * damping);
  const b = (velocity + damping * w0 * x0) / wd;
  const decay = Math.exp(-damping * w0 * t);
  const cos = Math.cos(wd * t);
  const sin = Math.sin(wd * t);
  const x = decay * (x0 * cos + b * sin);
  return { value: to + x, velocity: -damping * w0 * x + decay * (-x0 * wd * sin + b * wd * cos) };
}

/** At rest: within half a pixel of the target and moving slower than 20 px/s. */
export function springSettled(state: SpringState, to: number): boolean {
  return Math.abs(state.value - to) < 0.5 && Math.abs(state.velocity) < 20;
}
