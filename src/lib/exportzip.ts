/** Export raw workout data (everything needed to re-analyse it) as one zip, shared via the Android share sheet. */
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { ZipWriter } from "../core/zip";
import { getSettings } from "./settings";
import { APP_VERSION, workoutsDir } from "./workout";

const README = `MyoLift raw data export

workouts/<id>/
  workout.json   name, start/end time, unit
  events.jsonl   one JSON object per line: exercise, grip, weight, placement, calibration (+ placement
                 fingerprint), pause, set edits, photo checks. t = ms since the workout started.
  sensors.json   sensor id -> name -> file
  <sensor>.bin   raw EMG, append-only. Each row is 252 bytes:
                   float64 LE  ms since workout start (phone clock, when the packet arrived)
                   uint8       module number
                   uint24 LE   packet sequence number
                   uint16 LE   battery (V = raw / 16384 * 7.2)
                   119 x uint16 LE samples, 14-bit, 8192 = 0; microvolts = (raw - 8192) * 0.30518
                 Real sample rate is ~975 Hz (sensor clock), fit it from sequence number vs arrival time.
                 A packet whose samples are all 8192 is the once-a-minute battery measurement (no EMG).
  <sensor>.act   float32 LE envelope (µV, 100 ms RMS, 20 Hz high-pass + 50 Hz notch) in 20 ms bins from t = 0
  analysis.json  sets / reps / holds detected when the workout ended
  status.json    end time, duration, packet counts
settings.json    calibrations, placement references, stacks, exercises (no photos)
`;

async function bundle(ids: string[], label: string, progress?: (msg: string) => void): Promise<File> {
  const out = new File(Paths.cache, `myolift_${label}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.zip`);
  if (out.exists) out.delete();
  out.create();
  const z = new ZipWriter((chunk) => out.write(chunk, { append: true }));
  z.add("README.txt", new TextEncoder().encode(README));
  const s = getSettings();
  z.add("settings.json", new TextEncoder().encode(JSON.stringify({ ...s, placementPhotos: undefined, app: APP_VERSION }, null, 2)));
  let i = 0;
  for (const id of ids) {
    progress?.(`Packing ${++i}/${ids.length}…`);
    const dir = new Directory(workoutsDir(), id);
    if (!dir.exists) continue;
    for (const item of dir.list()) {
      if (!(item instanceof File) || item.name.endsWith(".zip")) continue;
      z.add(`workouts/${id}/${item.name}`, await item.bytes());
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  z.finish();
  return out;
}

async function shareZip(f: File) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device");
  await Sharing.shareAsync(f.uri, { mimeType: "application/zip", dialogTitle: f.name });
}

export async function exportWorkouts(ids: string[], progress?: (msg: string) => void) {
  await shareZip(await bundle(ids, ids.length === 1 ? ids[0].slice(0, 16) : "session", progress));
}

export async function exportAll(progress?: (msg: string) => void) {
  const ids = workoutsDir().list().filter((d): d is Directory => d instanceof Directory).map((d) => d.name).sort();
  await shareZip(await bundle(ids, "all", progress));
}
