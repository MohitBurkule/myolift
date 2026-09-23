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
}

const BUILTIN = data as Exercise[];

/** Short names for the exercises used most, so chips stay readable. */
const SHORT: Record<string, string> = {
  "Triceps_Pushdown_-_Rope_Attachment": "Rope pushdown",
  "Triceps_Pushdown": "Pushdown",
  "Triceps_Pushdown_-_V-Bar_Attachment": "V-bar pushdown",
  "Reverse_Grip_Triceps_Pushdown": "Reverse pushdown",
  "Cable_Rope_Overhead_Triceps_Extension": "Overhead rope ext.",
};

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
