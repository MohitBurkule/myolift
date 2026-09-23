/** Grip / attachment choices by equipment. Stored per set, so progress is compared per exercise + grip. */
const ATTACHMENTS = ["Rope", "Straight bar", "V-bar", "EZ-bar", "Single handle", "Reverse grip"];
const GRIPS = ["Overhand", "Underhand", "Neutral", "Wide", "Close"];

export function gripsFor(equipment: string | null | undefined): string[] {
  if (equipment === "cable") return ATTACHMENTS;
  if (equipment === "machine") return ["Neutral", "Overhand", "Underhand", "Wide", "Close", "Single arm"];
  if (equipment === "barbell" || equipment === "e-z curl bar") return ["Overhand", "Underhand", "Close", "Wide"];
  if (equipment === "dumbbell" || equipment === "kettlebells") return ["Neutral", "Underhand", "Overhand"];
  return GRIPS;
}

/** A sensible default grip when an exercise is picked (from its name). */
export function defaultGrip(name: string, equipment?: string | null): string {
  const n = name.toLowerCase();
  if (n.includes("rope")) return "Rope";
  if (n.includes("v-bar")) return "V-bar";
  if (n.includes("reverse")) return equipment === "cable" ? "Reverse grip" : "Underhand";
  if (n.includes("hammer")) return "Neutral";
  if (n.includes("ez")) return "EZ-bar";
  return "";
}
