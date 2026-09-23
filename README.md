# MyoLift

A gym log that fills itself in from EMG. Wear two ELEMYO **MYOblue** sensors (no USB dongle needed), start the workout once, and train.

- **Sets and reps are detected automatically** from muscle activity, left and right arm separately. There's no start/stop per set, and the rest timer runs by itself.
- **Minimal input.** The exercise, grip/attachment (rope, V-bar, straight bar…) and weight are sticky: they apply to every following set until you change them. Change the weight with −/+, a recent-weight chip or the keypad.
- **Drop sets, mechanical drop sets and supersets** are recognised: a weight change during a set or with no rest, a grip change with no rest, or a different exercise with no rest.
- **Beyond weight × reps:**
  - activation as % of the session's calibrated maximum
  - time under tension
  - **holds** (sustained contractions: duration and level, at the top or mid-range)
  - tempo per rep (activation rise and fall times)
  - **fatigue** (the EMG median frequency falling over a set)
  - left/right symmetry
  - form flags: rushed reps, uneven reps, activation falling off, one arm weaker, controlled tempo
- **Per-session calibration** (4 s relaxed, 4 s squeeze), because dry electrodes sit differently every time. That makes "% of max" comparable between sessions. It's required again after moving a sensor (e.g. triceps → biceps).
- **Raw data kept.** Every workout keeps the full raw EMG, so it can be re-analysed later. Export sets and reps as CSV.
- **Records in the background** (screen off, calls, other apps) in an Android foreground service.

## What EMG can and can't tell you

EMG measures muscle *activation*, not joint angles. "Form" here means what activation shows: rep-to-rep consistency, tempo, holds, fatigue and left/right balance. It can't see range of motion or elbow position.

## Install

Download the APK from the [latest release](https://github.com/MohitBurkule/myolift/releases/latest) on the phone and open it.

## How it works

- `modules/myoblue-native/`: Kotlin Expo module. It handles Bluetooth LE (Nordic UART) to the sensors, auto-reconnect, and a foreground service that appends every packet to disk.
- `src/core/workout.ts`: the detection. The envelope is turned into 50 Hz activation (% of the calibrated max); sets are active spans that end after N seconds of rest; reps are found by hysteresis on each set's own range (so a hold counts once); holds are steady plateaus; fatigue is the per-rep median frequency.
- `src/core/log.ts`: timestamped inputs (exercise, grip, weight, sensor placement, calibration, edits) combined with detected sets to give the log, drop sets and supersets.
- `src/core/offline.ts`: streaming analysis of the raw recording when a workout ends, in two passes and never loading the whole recording into memory.
- `tests/`: simulated workouts (bilateral and one arm, holds, fatigue, noise), run with `npm test`.
- CI (`.github/workflows/android.yml`): typecheck, tests, build, signing, an emulator smoke test with demo sensors, then a release.

Exercise list: [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (public domain). The Bluetooth/recording layer comes from [myoblue-ble](https://github.com/MohitBurkule/myoblue-ble).

## License

MIT
