/** The phone sheet's drag maths: momentum projection, rubber-banding, release velocity, the close/settle decision, springs. */
import { describe, expect, it } from "vitest";
import {
  FLICK_VELOCITY,
  SPRING_DEFAULT,
  SPRING_DRAWER,
  SPRING_FAST,
  decideRelease,
  project,
  releaseVelocity,
  rubberband,
  springAt,
  springSettled,
  type Sample,
} from "./sheet-physics";

describe("project", () => {
  it("is Apple's exponential decay at d = 0.998: 1,000 px/s comes to rest 499 px on", () => {
    expect(project(0)).toBe(0);
    expect(project(1000)).toBeCloseTo(499, 6);
    expect(project(-1000)).toBeCloseTo(-499, 6);
  });

  it("projects less with a snappier deceleration rate", () => {
    expect(project(1000, 0.99)).toBeCloseTo(99, 6);
    expect(Math.abs(project(1000, 0.99))).toBeLessThan(project(1000));
  });

  it("is linear in velocity, unlike v²/2a", () => {
    expect(project(2000)).toBeCloseTo(2 * project(1000), 6);
  });
});

describe("rubberband", () => {
  const height = 600;

  it("follows nearly 1:1 at first, then less and less", () => {
    expect(rubberband(0, height)).toBe(0);
    const small = rubberband(10, height);
    expect(small).toBeGreaterThan(5);
    expect(small).toBeLessThan(10);
    const step1 = rubberband(100, height) - rubberband(0, height);
    const step2 = rubberband(200, height) - rubberband(100, height);
    expect(step2).toBeLessThan(step1);
  });

  it("never passes the dimension, however far the finger goes", () => {
    expect(rubberband(100_000, height)).toBeLessThan(height);
    expect(rubberband(1_000_000, height)).toBeGreaterThan(height * 0.99);
  });

  it("keeps the sign: dragging above the open position stays above it", () => {
    expect(rubberband(-120, height)).toBeCloseTo(-rubberband(120, height), 9);
    expect(rubberband(-120, height)).toBeLessThan(0);
  });

  it("matches the skill's formula: (x·d·c) / (d + c·|x|)", () => {
    expect(rubberband(100, 600, 0.55)).toBeCloseTo((100 * 600 * 0.55) / (600 + 0.55 * 100), 9);
  });

  it("gives nothing for an empty sheet", () => {
    expect(rubberband(50, 0)).toBe(0);
  });
});

describe("releaseVelocity", () => {
  // A finger moving down 10 px every 16 ms: 625 px/s.
  const moving: Sample[] = [0, 16, 32, 48, 64].map((t, i) => ({ t: 1000 + t, y: 100 + i * 10 }));

  it("measures the last 80 ms of samples, in px/s", () => {
    expect(releaseVelocity(moving, 1064)).toBeCloseTo(625, 6);
  });

  it("is negative for an upward drag", () => {
    const up = moving.map((s) => ({ t: s.t, y: -s.y }));
    expect(releaseVelocity(up, 1064)).toBeCloseTo(-625, 6);
  });

  it("is 0 when the finger stopped before it lifted", () => {
    expect(releaseVelocity(moving, 1064 + 200)).toBe(0);
  });

  it("ignores samples older than the window", () => {
    const slowThenFast: Sample[] = [
      { t: 0, y: 0 },
      { t: 500, y: 5 },
      { t: 1000, y: 10 },
      { t: 1040, y: 50 },
      { t: 1060, y: 70 },
    ];
    // Only 1000..1060: 60 px in 60 ms.
    expect(releaseVelocity(slowThenFast, 1060)).toBeCloseTo(1000, 6);
  });

  it("is 0 with fewer than two samples (a tap)", () => {
    expect(releaseVelocity([], 10)).toBe(0);
    expect(releaseVelocity([{ t: 0, y: 40 }], 10)).toBe(0);
  });
});

describe("decideRelease", () => {
  const height = 600;

  it("decides a flick by the sign of its velocity, wherever the sheet is", () => {
    expect(decideRelease({ offset: 20, velocity: FLICK_VELOCITY, height })).toBe("dismiss");
    expect(decideRelease({ offset: 500, velocity: -FLICK_VELOCITY, height })).toBe("settle");
    expect(decideRelease({ offset: 5, velocity: 2500, height })).toBe("dismiss");
  });

  it("springs a short, slow drag back", () => {
    expect(decideRelease({ offset: 120, velocity: 0, height })).toBe("settle");
    expect(decideRelease({ offset: 120, velocity: 150, height })).toBe("settle");
  });

  it("closes a slow drag past half, and one whose momentum carries it past half", () => {
    expect(decideRelease({ offset: 320, velocity: 0, height })).toBe("dismiss");
    // 200 + project(300) ≈ 200 + 150 = 350 > 300.
    expect(decideRelease({ offset: 200, velocity: 300, height })).toBe("dismiss");
  });

  it("keeps a slow drag past half that is moving back up", () => {
    // 320 + project(-300) ≈ 320 − 150 = 170 < 300.
    expect(decideRelease({ offset: 320, velocity: -300, height })).toBe("settle");
  });

  it("settles a release above the open position (rubber-banded)", () => {
    expect(decideRelease({ offset: -30, velocity: 0, height })).toBe("settle");
  });
});

describe("springAt", () => {
  it("starts exactly where it is, at the velocity it was given (no seam: skill §5)", () => {
    for (const params of [SPRING_DEFAULT, SPRING_FAST, SPRING_DRAWER]) {
      const s = springAt(0, 240, 0, 1800, params);
      expect(s.value).toBeCloseTo(240, 9);
      expect(s.velocity).toBeCloseTo(1800, 6);
    }
  });

  it("comes to rest at its target", () => {
    for (const params of [SPRING_DEFAULT, SPRING_FAST, SPRING_DRAWER]) {
      const s = springAt(2, 600, 0, -900, params);
      expect(springSettled(s, 0)).toBe(true);
    }
  });

  it("never overshoots when critically damped and released at rest", () => {
    let min = Infinity;
    for (let t = 0; t <= 1; t += 0.005) min = Math.min(min, springAt(t, 300, 0, 0, SPRING_DEFAULT).value);
    expect(min).toBeGreaterThanOrEqual(-1e-9);
  });

  it("bounces a little after momentum: the drawer spring overshoots by about 1.5 %", () => {
    let min = Infinity;
    for (let t = 0; t <= 1; t += 0.001) min = Math.min(min, springAt(t, 300, 0, 0, SPRING_DRAWER).value);
    expect(min).toBeLessThan(0);
    expect(min).toBeGreaterThan(-300 * 0.02);
  });

  it("settles faster with a lower response", () => {
    const settleTime = (params: typeof SPRING_DEFAULT) => {
      for (let t = 0; t < 3; t += 0.001) if (springSettled(springAt(t, 500, 0, 0, params), 0)) return t;
      return Infinity;
    };
    expect(settleTime(SPRING_FAST)).toBeLessThan(settleTime(SPRING_DEFAULT));
  });

  it("reports the velocity that a new spring can continue from (finite differences agree)", () => {
    const dt = 1e-5;
    for (const params of [SPRING_DEFAULT, SPRING_DRAWER]) {
      const t = 0.12;
      const a = springAt(t, 400, 0, -600, params);
      const b = springAt(t + dt, 400, 0, -600, params);
      expect(a.velocity).toBeCloseTo((b.value - a.value) / dt, 0);
    }
  });
});
