import React, { useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { Side } from "../core/log";
import { compareSpots, type SensorSpot } from "../core/sensorspot";
import { Body, Button, Card, Title } from "../components/ui";
import { analysePhoto, keepPhoto } from "../lib/photo";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { useTheme } from "../lib/theme";
import { addEvent } from "../lib/workout";

/**
 * Photo check of a sensor position. The reference photo is shown faintly over the camera so the
 * arm can be framed the same way; the sensor is then found in both photos (red ELEMYO logo) and
 * compared: how far it moved and how much it's rotated.
 */
export default function PhotoScreen() {
  const t = useTheme();
  const { muscle, side } = useLocalSearchParams<{ muscle: string; side: Side }>();
  const key = `${muscle}|${side}`;
  const s = useSettings();
  const ref = s.placementPhotos[key];
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<"front" | "back">(ref?.facing ?? "front");
  const [shot, setShot] = useState<{ uri: string; spot: SensorSpot | null; w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!perm) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  if (!perm.granted) return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, gap: 12, justifyContent: "center" }}>
      <Body>The camera is used to photograph where the sensor sits, so you can put it back in the same place next time. Photos stay on the phone.</Body>
      <Button title="Allow camera" variant="primary" onPress={requestPerm} />
    </View>
  );

  async function take() {
    if (!cam.current || !ready) return;
    setBusy(true);
    try {
      const p = await cam.current.takePictureAsync({ quality: 0.8 });
      const uri = keepPhoto(p.uri, `${muscle}_${side}`);
      const spot = await analysePhoto(uri);
      setShot({ uri, spot, w: p.width, h: p.height });
    } finally { setBusy(false); }
  }

  if (shot) {
    const diff = shot.spot && ref?.spot ? compareSpots(shot.spot, ref.spot) : null;
    const messages = !shot.spot
      ? ["Couldn't find the sensor in the photo. Make sure the red ELEMYO logo is visible and well lit, then retake."]
      : diff ? diff.messages : ["Sensor found. Save this as the reference photo for this position."];
    return (
      <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        <Title>{side} {muscle}</Title>
        <Marked uri={shot.uri} spot={shot.spot} refSpot={ref?.spot ?? null} aspect={shot.w / shot.h} />
        <Card style={{ padding: 12, gap: 6 }}>
          {messages.map((m, i) => <Text key={i} style={{ color: t.ink }}>• {m}</Text>)}
          {diff ? <Text style={{ color: t.muted, fontSize: 12 }}>Distances are estimated from the logo size, so they're only as good as the framing. The green ring is the reference position, the blue ring is today.</Text> : null}
        </Card>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title="Retake" style={{ flex: 1 }} onPress={() => setShot(null)} />
          <Button title={ref ? "Done" : "Save as reference"} variant="primary" style={{ flex: 1 }} disabled={!shot.spot && !ref} onPress={() => {
            if (!ref && shot.spot) updateSettings({ placementPhotos: { ...getSettings().placementPhotos, [key]: { uri: shot.uri, spot: shot.spot, at: Date.now(), facing } } });
            addEvent({ type: "photo", muscle, side, uri: shot.uri, messages });
            router.back();
          }} />
        </View>
        {ref && shot.spot ? <Button small title="Replace the reference with this photo" onPress={() => {
          updateSettings({ placementPhotos: { ...getSettings().placementPhotos, [key]: { uri: shot.uri, spot: shot.spot, at: Date.now(), facing } } });
          router.back();
        }} /> : null}
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView ref={cam} style={{ flex: 1 }} facing={facing} onCameraReady={() => setReady(true)} />
      {ref ? <Image source={{ uri: ref.uri }} style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, opacity: 0.35, transform: facing === "front" && ref.facing === "front" ? [{ scaleX: -1 }] : [] }} resizeMode="cover" /> : null}
      <View style={{ position: "absolute", left: 12, right: 12, top: 12, padding: 10, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.55)" }}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>{side} {muscle}</Text>
        <Text style={{ color: "#ddd", fontSize: 13 }}>{ref ? "Line your arm up with the faint reference photo, same distance and angle, then take the photo." : "Arm relaxed, sensor and ELEMYO logo clearly visible, shoulder at the top of the frame. This becomes the reference."}</Text>
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 24, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 28 }}>
        <Pressable onPress={() => setFacing((f) => (f === "front" ? "back" : "front"))} accessibilityRole="button" accessibilityLabel="Switch camera"
          style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.5)" }}>
          <Text style={{ color: "#fff", fontWeight: "600" }}>Flip</Text>
        </Pressable>
        <Pressable onPress={take} disabled={!ready || busy} accessibilityRole="button" accessibilityLabel="Take photo"
          style={{ width: 74, height: 74, borderRadius: 37, borderWidth: 5, borderColor: "#fff", alignItems: "center", justifyContent: "center", opacity: ready ? 1 : 0.5 }}>
          {busy ? <ActivityIndicator color="#fff" /> : <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff" }} />}
        </Pressable>
        <View style={{ width: 56 }} />
      </View>
    </View>
  );
}

/** The photo with rings at the detected sensor (blue) and the reference position (green). */
function Marked({ uri, spot, refSpot, aspect }: { uri: string; spot: SensorSpot | null; refSpot: SensorSpot | null; aspect: number }) {
  const t = useTheme();
  const [w, setW] = useState(0);
  const h = w / (aspect || 0.75);
  const ring = (sp: SensorSpot, color: string) => {
    const x = (sp.x / sp.width) * w, y = (sp.y / sp.height) * h, r = Math.max(14, (sp.logoPx / sp.width) * w * 1.3);
    return <View key={color} style={{ position: "absolute", left: x - r, top: y - r, width: 2 * r, height: 2 * r, borderRadius: r, borderWidth: 3, borderColor: color }} />;
  };
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ width: "100%", height: h || 300, borderRadius: 12, overflow: "hidden", backgroundColor: t.panel2 }}>
      <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
      {w && refSpot ? ring(refSpot, t.ok) : null}
      {w && spot ? ring(spot, t.accent) : null}
    </View>
  );
}
