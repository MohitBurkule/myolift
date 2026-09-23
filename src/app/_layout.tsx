import React, { useEffect } from "react";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ensurePermissions, initSensors, nativeAvailable } from "../lib/sensors";
import { useTheme } from "../lib/theme";
import { initUpdates } from "../lib/update";
import { initWorkout } from "../lib/workout";

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    (async () => {
      if (nativeAvailable) await ensurePermissions();
      initSensors();
      initWorkout();
      initUpdates();
    })();
  }, []);
  const header = { headerStyle: { backgroundColor: t.panel }, headerTintColor: t.ink, headerShadowVisible: false, contentStyle: { backgroundColor: t.bg } };
  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <Stack screenOptions={header}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="scan" options={{ title: "Connect sensor", presentation: "modal" }} />
        <Stack.Screen name="sensors" options={{ title: "Sensors" }} />
        <Stack.Screen name="calibrate" options={{ title: "Calibrate", presentation: "modal", gestureEnabled: false }} />
        <Stack.Screen name="exercise" options={{ title: "Exercise", presentation: "modal" }} />
        <Stack.Screen name="weight" options={{ title: "Weight", presentation: "modal" }} />
        <Stack.Screen name="set" options={{ title: "Set" }} />
        <Stack.Screen name="photo" options={{ title: "Photo check" }} />
        <Stack.Screen name="workout/[id]" options={{ title: "Workout" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
