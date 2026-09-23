/** Exercise catalogue: free-exercise-db (public domain, bundled) + the user's own exercises. */
import data from "../data/exercises.json";
import { getSettings } from "./settings";

export interface Exercise {
  id: string;
  name: string;
  primary: string[];
  secondary: string[];
  equipment: string | null;
  mechanic: string | null;
  force: string | null;
  custom?: boolean;
  /** weight is assistance (e.g. assisted pull-up machine) */
  assisted?: boolean;
}

/** Machines missing from free-exercise-db. */
const EXTRA: Exercise[] = [
  { id: "machine_triceps_pushdown", name: "Machine Triceps Pushdown", primary: ["triceps"], secondary: [], equipment: "machine", mechanic: "isolation", force: "push" },
  { id: "machine_triceps_extension", name: "Machine Triceps Extension", primary: ["triceps"], secondary: [], equipment: "machine", mechanic: "isolation", force: "push" },
  { id: "machine_assisted_pullup", name: "Assisted Pull-up (machine)", primary: ["lats"], secondary: ["biceps", "middle back"], equipment: "machine", mechanic: "compound", force: "pull", assisted: true },
  { id: "machine_assisted_dip", name: "Assisted Dip (machine)", primary: ["triceps"], secondary: ["chest", "shoulders"], equipment: "machine", mechanic: "compound", force: "push", assisted: true },
  { id: "machine_biceps_curl", name: "Machine Biceps Curl", primary: ["biceps"], secondary: [], equipment: "machine", mechanic: "isolation", force: "pull" },
  { id: "machine_preacher_curl", name: "Machine Preacher Curl", primary: ["biceps"], secondary: [], equipment: "machine", mechanic: "isolation", force: "pull" },
];

const BUILTIN = [...EXTRA, ...(data as Exercise[])];

/** Short names for the exercises used most, so chips stay readable. */
const SHORT: Record<string, string> = {
  "Triceps_Pushdown_-_Rope_Attachment": "Rope pushdown",
  "Triceps_Pushdown": "Pushdown",
  "Triceps_Pushdown_-_V-Bar_Attachment": "V-bar pushdown",
  "Reverse_Grip_Triceps_Pushdown": "Reverse pushdown",
  "Cable_Rope_Overhead_Triceps_Extension": "Overhead rope ext.",
  machine_triceps_pushdown: "Machine pushdown",
  machine_assisted_pullup: "Assisted pull-up",
  machine_assisted_dip: "Assisted dip",
};

/** One arm at a time by default (single-arm sets count) for these names. */
export function isUnilateral(e: { name: string }): boolean {
  return /one[- ]arm|single[- ]arm|concentration|kickback|one hand|unilateral/i.test(e.name);
}

/** Does a sensor on `muscle` see this exercise's main work? */
export function worksMuscle(e: Exercise | undefined, muscle: string): "primary" | "secondary" | "no" | "unknown" {
  if (!e) return "unknown";
  if (e.primary.includes(muscle)) return "primary";
  if (e.secondary.includes(muscle)) return "secondary";
  return e.primary.length ? "no" : "unknown";
}

export function shortName(e: { id: string; name: string }): string {
  return SHORT[e.id] ?? e.name.replace(/ - /g, " · ");
}

export function allExercises(): Exercise[] {
  const custom = getSettings().customExercises.map((c) => ({ ...c, secondary: [], mechanic: null, force: null, custom: true }));
  return [...custom, ...BUILTIN];
}

export function findExercise(id: string): Exercise | undefined {
  return allExercises().find((e) => e.id === id);
}

export const MUSCLES = ["triceps", "biceps", "forearms", "shoulders", "chest", "lats", "middle back", "quadriceps", "hamstrings", "glutes", "calves", "abdominals"];

/** Search by name; exercises for the placed muscles and recent ones first. */
export function searchExercises(query: string, muscles: string[]): Exercise[] {
  const q = query.trim().toLowerCase();
  const recent = getSettings().recentExercises;
  const list = allExercises().filter((e) => !q || e.name.toLowerCase().includes(q) || shortName(e).toLowerCase().includes(q));
  const score = (e: Exercise) => {
    let s = 0;
    const r = recent.indexOf(e.id);
    if (r >= 0) s += 100 - r;
    if (e.primary.some((m) => muscles.includes(m))) s += 50;
    else if (e.secondary.some((m) => muscles.includes(m))) s += 10;
    if (e.custom) s += 5;
    return s;
  };
  return list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name)).slice(0, 80);
}
