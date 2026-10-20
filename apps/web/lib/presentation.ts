/**
 * Recording mode (UX-PLAN D14): `?recording=1` once, then kept for the tab in sessionStorage; `?recording=0` turns it
 * off. The quick settings and the Settings page also switch it (setRecording, UX round 2). While it is on, the UI hides
 * demo and developer tools (officer Demo tools, the "Try an attack" panel, deployment ids, "Clear this chat"). It only
 * ever HIDES: it never enables anything, never changes a check, and never hides the "Sample" labels.
 * The server knows nothing about it.
 */
import { useSyncExternalStore } from "react";

export const RECORDING_PARAM = "recording";
export const RECORDING_STORAGE_KEY = "hogee.recording";

export interface RecordingState {
  /** Hide demo and developer tools. */
  readonly recording: boolean;
  /** What to keep in sessionStorage ("1" on, "0" off), when the URL said so. */
  readonly store?: "1" | "0";
}

/** From the URL's query string and the stored value: the URL wins, then the stored value; anything else is off. */
export function resolveRecording(search: string, stored: string | null): RecordingState {
  const value = new URLSearchParams(search).get(RECORDING_PARAM);
  if (value === "1" || value === "true") return { recording: true, store: "1" };
  if (value === "0" || value === "false") return { recording: false, store: "0" };
  return { recording: stored === "1" };
}

/** Fired on window when setRecording changes the mode, so every view re-reads it. */
export const RECORDING_EVENT = "hogee:recording";

/** The query string without the recording flag (setRecording drops it, so the URL never overrules the switch). */
export function withoutRecordingParam(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(RECORDING_PARAM)) return search;
  params.delete(RECORDING_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

// The switch's last choice in this page view, for when the tab's storage is blocked.
let chosen: "1" | "0" | null = null;

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(RECORDING_STORAGE_KEY) ?? chosen;
  } catch {
    return chosen; // storage blocked (private window, previews): the URL, then this page view's choice, decide
  }
}

function keep(value: "1" | "0"): void {
  try {
    window.sessionStorage.setItem(RECORDING_STORAGE_KEY, value);
  } catch {
    // storage blocked: recording mode then lasts only while the URL carries ?recording=1
  }
}

function clientRecording(): boolean {
  const state = resolveRecording(window.location.search, readStored());
  if (state.store) keep(state.store);
  return state.recording;
}

/**
 * Turns recording mode on or off for this tab (the quick settings' and the Settings page's switch). It keeps the choice
 * in sessionStorage like `?recording=`, drops the flag from the address bar so a stale `?recording=1` cannot turn it
 * back on, and tells every view. Like the URL flag, it only hides demo tools; it never enables anything.
 */
export function setRecording(on: boolean): void {
  const value = on ? "1" : "0";
  chosen = value;
  keep(value);
  const { pathname, search, hash } = window.location;
  const rest = withoutRecordingParam(search);
  if (rest !== search) window.history.replaceState(window.history.state, "", `${pathname}${rest}${hash}`);
  window.dispatchEvent(new Event(RECORDING_EVENT));
}

// The URL, this tab's storage and setRecording change it; a client navigation re-renders and re-reads it.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(RECORDING_EVENT, onChange);
  return () => window.removeEventListener(RECORDING_EVENT, onChange);
}

/**
 * True while recording. The server render (and the first client render) says true, so a demo tool never flashes
 * into a recording before the browser has read the flag; the tools appear right after hydration otherwise.
 */
export function useRecording(): boolean {
  return useSyncExternalStore(subscribe, clientRecording, () => true);
}
