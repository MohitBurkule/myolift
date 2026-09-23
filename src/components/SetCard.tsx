import React from "react";
import { Pressable, Text, View } from "react-native";
import type { LoggedSet } from "../core/log";
import { shortName } from "../lib/exercises";
import { useTheme } from "../lib/theme";
import { Card, Pill } from "./ui";

const GROUP_LABEL = { drop: "Drop set", mech: "Mechanical drop", super: "Superset" } as const;

export function SetCard({ set, index, onPress }: { set: LoggedSet; index: number; onPress?: () => void }) {
  const t = useTheme();
  const left = set.sides.find((s) => s.side === "left"), right = set.sides.find((s) => s.side === "right");
  const peak = set.sides.length ? set.sides.reduce((m, s) => m + s.peak, 0) / set.sides.length : 0;
  const tut = Math.max(0, ...set.sides.map((s) => s.activeS));
  const holds = set.sides.reduce((n, s) => n + s.holds.length, 0);
  const w = set.segments ? set.segments.map((g) => `${fmt(g.weight)}×${g.reps}`).join(" → ") : set.weight !== null ? `${fmt(set.weight)} ${set.unit} × ${set.reps}` : `${set.reps} reps`;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Set ${index}`}>
      <Card style={{ padding: 12, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: t.muted, fontWeight: "700", width: 26, fontVariant: ["tabular-nums"] }}>#{index}</Text>
          <Text style={{ color: t.ink, fontWeight: "700", flex: 1 }} numberOfLines={1}>{shortName({ id: set.exerciseId, name: set.exerciseName })}{set.grip ? ` · ${set.grip}` : ""}</Text>
          {set.group ? <Pill text={GROUP_LABEL[set.group]} tone="accent" /> : null}
          {set.edited ? <Pill text="edited" /> : null}
        </View>
        <Text style={{ color: t.ink, fontSize: 17, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
          {w}{left && right ? <Text style={{ color: t.muted, fontSize: 13, fontWeight: "400" }}>{`   L ${left.reps.length} · R ${right.reps.length}`}</Text> : null}
        </Text>
        <Text style={{ color: t.muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>
          {peak.toFixed(0)}% activation · {tut.toFixed(0)} s TUT{holds ? ` · ${holds} hold${holds > 1 ? "s" : ""}` : ""}
        </Text>
        {set.flags.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {set.flags.map((f, i) => <Pill key={i} text={f.text} tone={f.kind === "good" ? "ok" : "warn"} />)}
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
