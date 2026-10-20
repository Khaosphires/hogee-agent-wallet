import { useSyncExternalStore } from "react";

// One shared 1-second ticker for countdowns (timelocks, signature expiry).
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 1_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time in ms, updated every second while any component uses it. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => 0);
}
