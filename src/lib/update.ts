/**
 * Updates from GitHub releases. Each CI build is published as release "build-N" with
 * myolift-N.apk, and N is also the app's versionCode, so a newer release is simply a larger N.
 * With auto-install on, a newer build is downloaded and installed when the app is opened and no
 * workout is recording (installing restarts the app).
 */
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import Native from "../../modules/myoblue-native";
import { getSettings } from "./settings";
import { activeWorkoutId } from "./workout";

const REPO = "MohitBurkule/myolift";
const CHECK_EVERY_MS = 60 * 60 * 1000;

export interface Release { build: number; url: string; sizeMb: number; publishedAt: string; page: string }
export interface UpdateState {
  current: number;
  latest: Release | null;
  checkedAt: number;
  phase: "idle" | "checking" | "download" | "install" | "confirm" | "done" | "error";
  progress: number;
  message: string | null;
}

let state: UpdateState = { current: Native?.appVersionCode() ?? 0, latest: null, checkedAt: 0, phase: "idle", progress: 0, message: null };
const subs = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };
export const useUpdate = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state);
export const updateAvailable = (s: UpdateState = state) => !!s.latest && s.current > 0 && s.latest.build > s.current;

/** Parse the GitHub "latest release" response. */
export function parseRelease(j: any): Release | null {
  const m = /^build-(\d+)$/.exec(j?.tag_name ?? "");
  const apk = (j?.assets ?? []).find((a: any) => /\.apk$/.test(a.name));
  if (!m || !apk) return null;
  return { build: Number(m[1]), url: apk.browser_download_url, sizeMb: apk.size / 1e6, publishedAt: j.published_at, page: j.html_url };
}

export async function checkForUpdate(force = false): Promise<Release | null> {
  if (!Native || state.phase === "checking" || state.phase === "download" || state.phase === "install") return state.latest;
  if (!force && Date.now() - state.checkedAt < CHECK_EVERY_MS) return state.latest;
  set({ phase: "checking", message: null });
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const latest = parseRelease(await r.json());
    set({ latest, checkedAt: Date.now(), phase: "idle" });
    if (updateAvailable() && getSettings().autoUpdate && !activeWorkoutId() && Native.canInstallUpdates()) installUpdate();
    return latest;
  } catch (e: any) {
    set({ phase: force ? "error" : "idle", checkedAt: Date.now(), message: force ? `Couldn't check for updates: ${e?.message ?? e}` : null });
    return null;
  }
}

/** Download and install the latest build. Returns false when it can't start (see message). */
export function installUpdate(): boolean {
  if (!Native || !state.latest) return false;
  if (activeWorkoutId()) { set({ phase: "error", message: "Finish the workout first: installing restarts the app." }); return false; }
  if (!Native.canInstallUpdates()) { set({ phase: "error", message: "Allow MyoLift to install apps first (the button below), then tap Update again." }); return false; }
  if (!Native.installUpdate(state.latest.url)) return false;
  set({ phase: "download", progress: 0, message: null });
  return true;
}

export function initUpdates() {
  if (!Native) return;
  Native.addListener("onUpdate", (e) => set({ phase: e.phase, progress: e.progress, message: e.message }));
  checkForUpdate();
  AppState.addEventListener("change", (s) => { if (s === "active") checkForUpdate(); });
}
