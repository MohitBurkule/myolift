/** Weight stacks: the weights a machine actually offers. +/- steps through them. */
import type { Unit } from "./log";

/** Common pin-loaded stack: 2.5 lb top plate + 5 lb plates (1.1, 3.4, 5.7 … 44.2 kg), as on the user's cable machine. */
export function lbStack(count = 20, first = 2.5, step = 5): number[] {
  return Array.from({ length: count }, (_, i) => first + i * step);
}
export const LB_TO_KG = 0.45359237;
export function defaultStack(unit: Unit): number[] {
  const lb = lbStack();
  return unit === "lb" ? lb : lb.map((x) => Math.round(x * LB_TO_KG * 10) / 10);
}

/** Parse "1.1, 3.4, 5.7" or "1.1-44.2 step 2.27" into a sorted list. */
export function parseStack(text: string): number[] | null {
  const m = text.match(/^\s*([\d.]+)\s*-\s*([\d.]+)\s*(?:step|by|\+)\s*([\d.]+)\s*$/i);
  if (m) {
    const [a, b, st] = [+m[1], +m[2], +m[3]];
    if (!(st > 0) || b < a) return null;
    const out: number[] = [];
    for (let v = a; v <= b + 1e-6 && out.length < 200; v += st) out.push(Math.round(v * 100) / 100);
    return out;
  }
  const vals = text.split(/[,\s]+/).filter(Boolean).map(Number);
  if (!vals.length || vals.some((v) => !(v >= 0))) return null;
  return [...new Set(vals)].sort((x, y) => x - y);
}

/** Next / previous weight on the stack from the current one. */
export function stepStack(stack: number[], current: number | null, dir: 1 | -1): number {
  if (!stack.length) return current ?? 0;
  if (current === null) return stack[0];
  if (dir > 0) return stack.find((v) => v > current + 1e-6) ?? stack[stack.length - 1];
  return [...stack].reverse().find((v) => v < current - 1e-6) ?? stack[0];
}

/** Stack for this exercise: the saved one, or the common pin stack for cable/machine exercises. */
export function stackFor(stacks: Record<string, number[]>, exerciseId: string | null, equipment: string | null, unit: Unit): number[] | null {
  if (exerciseId && stacks[exerciseId]) return stacks[exerciseId].length ? stacks[exerciseId] : null; // [] = no stack
  if (equipment === "cable" || equipment === "machine") return defaultStack(unit);
  return null;
}

