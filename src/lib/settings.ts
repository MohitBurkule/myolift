import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import type { BandId } from "../core/dsp";
import type { Calibration } from "../core/calibration";
import type { Placement, Unit } from "../core/log";
import type { Reference } from "../core/workout";
import type { Fingerprint, Labelled } from "../core/placement";

export type ViewMode = "filtered" | "raw" | "envelope";
export type YScale = "auto" | "hold" | "mvc" | "100" | "250" | "500" | "1000" | "2500";

export interface Settings {
  viewMode: ViewMode;
  band: BandId;
  notch: 0 | 50 | 60;
  win: 2 | 5 | 10;
  scale: YScale;
  overlay: boolean;
  spectrum: boolean;
  markerLabels: string;
  /** sensors to reconnect automatically when the app starts */
  knownSensors: { id: string; name: string }[];
  /** keyed by sensor name (stable across phones) */
  calibrations: Record<string, Calibration>;
  /* ---- workout ---- */
  unit: Unit;
  weight: number | null;
  weightStep: number;
  recentWeights: number[];
  exercise: { id: string; name: string } | null;
  grip: string;
  recentExercises: string[];
  customExercises: { id: string; name: string; primary: string[]; equipment: string | null }[];
  placements: Placement[];
  /** session calibration per sensor+muscle+side */
  refs: Record<string, { ref: Reference; snrDb: number; at: number; placement?: { status: string; similarity: number | null; messages: string[] } }>;
  /** seconds without activity that end a set */
  restGapS: number;
  /** placement check during calibration (extra movements) */
  placementCheck: boolean;
  /** reference placement fingerprint per "muscle|side", plus labelled offsets it has learned */
  placementRefs: Record<string, { ref: Fingerprint; at: number; offsets: Labelled[] }>;
}

const DEFAULTS: Settings = {
  viewMode: "filtered",
  band: "emg",
  notch: 50,
  win: 5,
  scale: "auto",
  overlay: true,
  spectrum: false,
  markerLabels: "rest, contract, trial",
  knownSensors: [],
  calibrations: {},
  unit: "kg",
  weight: null,
  weightStep: 2.5,
  recentWeights: [],
  exercise: { id: "Triceps_Pushdown_-_Rope_Attachment", name: "Triceps Pushdown - Rope Attachment" },
  grip: "Rope",
  recentExercises: ["Triceps_Pushdown_-_Rope_Attachment"],
  customExercises: [],
  placements: [],
  refs: {},
  restGapS: 6,
  placementCheck: true,
  placementRefs: {},
};

const file = () => new File(Paths.document, "settings.json");

function load(): Settings {
  try {
    const f = file();
    if (f.exists) return { ...DEFAULTS, ...JSON.parse(f.textSync()) };
  } catch {}
  return { ...DEFAULTS };
}

let current: Settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    const f = file();
    if (!f.exists) f.create();
    f.write(JSON.stringify(current, null, 2));
  } catch {}
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

export function markerLabels(s: Settings): string[] {
  return s.markerLabels.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
}
