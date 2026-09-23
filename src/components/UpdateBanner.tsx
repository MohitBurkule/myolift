import React from "react";
import { Text, View } from "react-native";
import Native from "../../modules/myoblue-native";
import { installUpdate, updateAvailable, useUpdate } from "../lib/update";
import { useTheme } from "../lib/theme";
import { Button, Card } from "./ui";

/** "Build N is ready" with Update, download progress, and install problems. Hidden when up to date. */
export function UpdateBanner({ always }: { always?: boolean }) {
  const t = useTheme();
  const u = useUpdate();
  const busy = u.phase === "download" || u.phase === "install" || u.phase === "confirm";
  if (!Native || (!always && !updateAvailable(u) && !busy)) return null;
  const text = u.phase === "download" ? `Downloading build ${u.latest?.build}… ${Math.round(u.progress * 100)}%`
    : u.phase === "install" ? "Installing… the app restarts when it's done."
    : u.phase === "confirm" ? "Tap Update in the system prompt to finish."
    : updateAvailable(u) ? `Build ${u.latest!.build} is available (${u.latest!.sizeMb.toFixed(0)} MB).`
    : u.phase === "checking" ? "Checking for updates…"
    : u.latest ? `Up to date (build ${u.current}).` : `Build ${u.current}.`;
  const noPermission = !Native.canInstallUpdates();
  return (
    <Card style={{ padding: 12, gap: 8, borderColor: updateAvailable(u) ? t.accent : t.line }}>
      <Text style={{ color: t.ink, fontWeight: "600" }}>{text}</Text>
      {u.phase === "download" ? (
        <View style={{ height: 6, borderRadius: 999, backgroundColor: t.panel2, overflow: "hidden" }}>
          <View style={{ width: `${u.progress * 100}%`, height: "100%", backgroundColor: t.accent }} />
        </View>
      ) : null}
      {u.message ? <Text style={{ color: u.phase === "error" ? t.warn : t.muted, fontSize: 13 }}>{u.message}</Text> : null}
      {updateAvailable(u) && !busy ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button small variant="primary" title="Update" onPress={installUpdate} />
          {noPermission ? <Button small title="Allow installing updates" onPress={() => Native!.openInstallPermission()} /> : null}
        </View>
      ) : null}
    </Card>
  );
}
