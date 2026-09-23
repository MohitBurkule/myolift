/** Placement photos: save, shrink, and find the sensor in them. */
import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { decode } from "jpeg-js";
import { base64ToBytes } from "../core/protocol";
import { findSensor, type SensorSpot } from "../core/sensorspot";

export function photosDir(): Directory {
  const d = new Directory(Paths.document, "placement-photos");
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** Copy a camera capture into the app's folder (the camera's file is temporary). */
export function keepPhoto(uri: string, name: string): string {
  const src = new File(uri);
  const dst = new File(photosDir(), `${name}_${Date.now()}.jpg`);
  src.copy(dst);
  return dst.uri;
}

/** Shrink to 360 px wide, decode, and find the red ELEMYO logo on the black sensor. */
export async function analysePhoto(uri: string): Promise<SensorSpot | null> {
  const ctx = ImageManipulator.manipulate(uri);
  ctx.resize({ width: 360 });
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ format: SaveFormat.JPEG, base64: true, compress: 0.9 });
  if (!out.base64) return null;
  const d = decode(base64ToBytes(out.base64), { useTArray: true, formatAsRGBA: true });
  return findSensor({ width: d.width, height: d.height, data: d.data });
}
