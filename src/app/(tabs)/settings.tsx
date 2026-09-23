import React, { useCallback, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Native from "../../../modules/myoblue-native";
import { Body, Button, Card, Choice, Label, Title } from "../../components/ui";
import { removeSensor } from "../../lib/sensors";
import { updateSettings, useSettings } from "../../lib/settings";
import { useTheme } from "../../lib/theme";
import { APP_VERSION } from "../../lib/workout";

export default function SettingsScreen() {
  const t = useTheme();
  const s = useSettings();
  const insets = useSafeAreaInsets();
  const [batteryOk, setBatteryOk] = useState(true);
  useFocusEffect(useCallback(() => { setBatteryOk(Native?.ignoringBatteryOptimizations() ?? true); }, []));
  const card = { padding: 14, gap: 14 };
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, paddingTop: insets.top + 12, gap: 12, paddingBottom: 40 }}>
      <Title>Settings</Title>
      <Label>Workout</Label>
      <Card style={card}>
        <Choice label="Units" value={s.unit} onChange={(u) => updateSettings({ unit: u })} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} />
        <Choice label="Weight +/− step" value={s.weightStep} onChange={(v) => updateSettings({ weightStep: v })} options={[1, 2, 2.5, 5, 10].map((x) => ({ value: x, label: String(x) }))} />
        <Choice label="A set ends after this much rest" value={s.restGapS} onChange={(v) => updateSettings({ restGapS: v })}
          options={[4, 6, 8, 12].map((x) => ({ value: x, label: `${x} s` }))} />
        <Body muted style={{ fontSize: 13 }}>Shorter splits long pauses inside a set (e.g. a long hold at the bottom) into separate sets; longer merges quick supersets into one set.</Body>
      </Card>

      <Label>Background recording</Label>
      <Card style={card}>
        <Body>A workout records in a foreground service (the ongoing notification), so it continues with the screen off, during calls and with other apps open.</Body>
        {batteryOk ? <Body muted style={{ fontSize: 13 }}>Battery optimisation is off for MyoLift.</Body> : (
          <Button title="Turn off battery optimisation" onPress={() => Native?.openBatterySettings()} />
        )}
      </Card>

      <Label>Sensors</Label>
      <Card style={card}>
        {s.knownSensors.length ? s.knownSensors.map((k) => (
          <View key={k.id} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.ink, fontWeight: "600" }}>{k.name.replace(/_/g, " ")}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{k.id} · reconnects automatically</Text>
            </View>
            <Button title="Forget" small onPress={() => removeSensor(k.id)} />
          </View>
        )) : <Body muted>No saved sensors.</Body>}
      </Card>

      <Label>My exercises</Label>
      <Card style={card}>
        {s.customExercises.length ? s.customExercises.map((e) => (
          <View key={e.id} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ color: t.ink, flex: 1 }}>{e.name}</Text>
            <Button small title="Remove" onPress={() => updateSettings({ customExercises: s.customExercises.filter((x) => x.id !== e.id) })} />
          </View>
        )) : <Body muted>Add your own from the exercise search.</Body>}
      </Card>

      <Body muted style={{ fontSize: 12, textAlign: "center" }}>MyoLift {APP_VERSION} · ELEMYO MYOblue sensors · exercise list from free-exercise-db (public domain)</Body>
    </ScrollView>
  );
}
