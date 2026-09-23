/**
 * Find the MYOblue sensor in a photo: the red "ELEMYO" logo on a black body.
 * Works on a small RGBA image (~360 px wide). Gives the sensor centre, the logo direction
 * (rotation) and a scale (px per mm) from the logo length, so two photos taken with the same
 * framing (ghost overlay) can be compared: "sensor 1.5 cm higher, rotated 20°".
 */

export interface Image { width: number; height: number; data: Uint8Array | Uint8ClampedArray } // RGBA

export interface SensorSpot {
  x: number; // centre, px
  y: number;
  /** logo direction in degrees, 0 = horizontal, (-90, 90] */
  angle: number;
  /** logo length in px (scale) */
  logoPx: number;
  /** px per mm, from the logo length (the printed logo is ~14 mm long on the 30 x 21.5 mm sensor) */
  pxPerMm: number;
  /** 0..1 confidence (dark body around the logo, logo shape) */
  confidence: number;
  width: number;
  height: number;
}

export const LOGO_MM = 14;

function isRed(r: number, g: number, b: number) {
  return r > 120 && r - g > 60 && r > g * 1.8 && r > b * 1.6;
}
function isDark(r: number, g: number, b: number) {
  return Math.max(r, g, b) < 75;
}

/** Candidate red clusters (after a small dilation so the letters join). */
function redClusters(img: Image) {
  const { width: W, height: H, data } = img;
  const red = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) if (isRed(data[p], data[p + 1], data[p + 2])) red[i] = 1;
  // dilate by 2 px so the letters of "ELEMYO" form one component
  const dil = new Uint8Array(W * H);
  const R = 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!red[y * W + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) dil[yy * W + xx] = 1;
    }
  }
  const label = new Int32Array(W * H).fill(-1);
  const clusters: { pts: number[] }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!dil[i] || label[i] >= 0) continue;
    const id = clusters.length, pts: number[] = [];
    label[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      if (red[j]) pts.push(j);
      const x = j % W, y = (j / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const k = yy * W + xx;
        if (dil[k] && label[k] < 0) { label[k] = id; stack.push(k); }
      }
    }
    clusters.push({ pts });
  }
  return clusters;
}

export function findSensor(img: Image): SensorSpot | null {
  const { width: W, height: H, data } = img;
  let best: SensorSpot | null = null, bestScore = 0;
  for (const c of redClusters(img)) {
    const n = c.pts.length;
    if (n < 12 || n > W * H * 0.02) continue; // too small (noise) or too big (a red object)
    // centroid and principal axis
    let mx = 0, my = 0;
    for (const i of c.pts) { mx += i % W; my += (i / W) | 0; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const i of c.pts) { const dx = (i % W) - mx, dy = ((i / W) | 0) - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(theta), uy = Math.sin(theta);
    let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
    for (const i of c.pts) {
      const dx = (i % W) - mx, dy = ((i / W) | 0) - my;
      const a = dx * ux + dy * uy, b = -dx * uy + dy * ux;
      lo = Math.min(lo, a); hi = Math.max(hi, a); wlo = Math.min(wlo, b); whi = Math.max(whi, b);
    }
    const len = hi - lo, thick = whi - wlo;
    const elong = len / Math.max(1, thick);
    if (len < 8 || elong < 2.2) continue; // text is long and thin
    // the logo sits on a black body: count dark pixels in a box around it, excluding the red ones
    const r = Math.round(len * 0.9);
    let dark = 0, tot = 0;
    for (let y = Math.max(0, Math.round(my - r)); y < Math.min(H, Math.round(my + r)); y++) {
      for (let x = Math.max(0, Math.round(mx - r)); x < Math.min(W, Math.round(mx + r)); x++) {
        const p = (y * W + x) * 4;
        if (isRed(data[p], data[p + 1], data[p + 2])) continue;
        tot++;
        if (isDark(data[p], data[p + 1], data[p + 2])) dark++;
      }
    }
    const darkFrac = tot ? dark / tot : 0;
    if (darkFrac < 0.3) continue;
    const confidence = Math.min(1, darkFrac * 1.2) * Math.min(1, elong / 4);
    const score = confidence * Math.sqrt(n);
    if (score > bestScore) {
      bestScore = score;
      let angle = (theta * 180) / Math.PI;
      if (angle <= -90) angle += 180;
      if (angle > 90) angle -= 180;
      best = { x: mx, y: my, angle, logoPx: len, pxPerMm: len / LOGO_MM, confidence, width: W, height: H };
    }
  }
  return best;
}

/** The spot as it would be in the left-right mirrored photo (a reference taken on the other arm). */
export function mirrorSpot(s: SensorSpot): SensorSpot {
  let angle = -s.angle;
  if (angle <= -90) angle += 180;
  return { ...s, x: s.width - s.x, angle };
}

export interface SpotDiff {
  /** + = lower in the photo (toward the elbow when the shoulder is at the top) */
  downMm: number;
  /** + = to the right in the photo */
  rightMm: number;
  /** rotation difference, degrees (-90, 90] */
  rotationDeg: number;
  /** framing check: logo size ratio; far from 1 means the phone was closer or further away */
  scaleRatio: number;
  messages: string[];
}

/** Compare today's photo with the reference (both taken aligned to the same ghost overlay). */
export function compareSpots(now: SensorSpot, ref: SensorSpot): SpotDiff {
  // normalise both to the reference image size
  const sx = ref.width / now.width, sy = ref.height / now.height;
  const pxPerMm = ref.pxPerMm;
  const dx = (now.x * sx - ref.x) / pxPerMm, dy = (now.y * sy - ref.y) / pxPerMm;
  let rot = now.angle - ref.angle;
  if (rot > 90) rot -= 180;
  if (rot <= -90) rot += 180;
  const scaleRatio = (now.logoPx * sx) / ref.logoPx;
  const msgs: string[] = [];
  if (Math.abs(scaleRatio - 1) > 0.25) msgs.push(`The phone was ${scaleRatio > 1 ? "closer" : "further away"} than for the reference: line the arm up with the ghost outline and retake.`);
  const cm = (mm: number) => (Math.abs(mm) / 10).toFixed(1);
  if (Math.abs(dy) >= 8) msgs.push(`Sensor about ${cm(dy)} cm ${dy > 0 ? "lower (toward the elbow)" : "higher (toward the shoulder)"} than your reference.`);
  if (Math.abs(dx) >= 8) msgs.push(`About ${cm(dx)} cm to the ${dx > 0 ? "right" : "left"} in the photo.`);
  if (Math.abs(rot) >= 15) msgs.push(`Rotated about ${Math.round(Math.abs(rot))}° compared with your reference.`);
  if (!msgs.length) msgs.push("Matches the reference photo ✓");
  return { downMm: dy, rightMm: dx, rotationDeg: rot, scaleRatio, messages: msgs };
}
