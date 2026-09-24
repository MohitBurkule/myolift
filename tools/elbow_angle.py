#!/usr/bin/env python3
"""
Elbow angle from an experiment video, on the EMG clock.

  python tools/elbow_angle.py <experiment dir> [--model pose_landmarker_full.task] [--every 1]

Reads experiment.json + video.mp4 (from a MyoLift experiments export), runs MediaPipe pose on
every frame and writes <dir>/angle.csv:
  t_emg_s, t_video_s, left_2d, right_2d, left_3d, right_3d, left_vis, right_vis
Angles are elbow flexion in degrees: 0 = straight arm, 90 = right angle. 2D uses the image
landmarks (best when the camera is side-on); 3D uses MediaPipe's world landmarks (less sensitive
to the camera angle, noisier). t_emg_s = t_video_s + video.offsetS from experiment.json.

Needs: pip install mediapipe opencv-python-headless, and the pose model from
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
"""
import argparse, csv, json, math, os, sys

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

SHOULDER, ELBOW, WRIST = {"left": 11, "right": 12}, {"left": 13, "right": 14}, {"left": 15, "right": 16}


def flexion(a, b, c):
    """Angle at b between b->a and b->c, as flexion (180 - inner angle)."""
    v1 = [a[i] - b[i] for i in range(len(a))]
    v2 = [c[i] - b[i] for i in range(len(c))]
    n1 = math.sqrt(sum(x * x for x in v1)); n2 = math.sqrt(sum(x * x for x in v2))
    if n1 == 0 or n2 == 0:
        return float("nan")
    cos = max(-1.0, min(1.0, sum(v1[i] * v2[i] for i in range(len(v1))) / (n1 * n2)))
    return 180.0 - math.degrees(math.acos(cos))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--model", default=os.path.join(os.path.dirname(__file__), "pose_landmarker_full.task"))
    ap.add_argument("--every", type=int, default=1, help="analyse every Nth frame")
    a = ap.parse_args()
    meta = json.load(open(os.path.join(a.dir, "experiment.json")))
    offset = (meta.get("video") or {}).get("offsetS", 0.0)
    cap = cv2.VideoCapture(os.path.join(a.dir, "video.mp4"))
    if not cap.isOpened():
        sys.exit("can't open video.mp4")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=a.model), running_mode=vision.RunningMode.VIDEO)
    rows, i = [], 0
    with vision.PoseLandmarker.create_from_options(opts) as det:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            tv = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 or i / fps
            if i % a.every == 0:
                h, w = frame.shape[:2]
                img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                r = det.detect_for_video(img, int(tv * 1000))
                row = {"t_emg_s": round(tv + offset, 3), "t_video_s": round(tv, 3)}
                for side in ("left", "right"):
                    if r.pose_landmarks:
                        lm, wl = r.pose_landmarks[0], r.pose_world_landmarks[0]
                        p = lambda k: (lm[k].x * w, lm[k].y * h)
                        q = lambda k: (wl[k].x, wl[k].y, wl[k].z)
                        row[f"{side}_2d"] = round(flexion(p(SHOULDER[side]), p(ELBOW[side]), p(WRIST[side])), 1)
                        row[f"{side}_3d"] = round(flexion(q(SHOULDER[side]), q(ELBOW[side]), q(WRIST[side])), 1)
                        row[f"{side}_vis"] = round(min(lm[k].visibility for k in (SHOULDER[side], ELBOW[side], WRIST[side])), 2)
                    else:
                        row[f"{side}_2d"] = row[f"{side}_3d"] = row[f"{side}_vis"] = ""
                rows.append(row)
            i += 1
    out = os.path.join(a.dir, "angle.csv")
    with open(out, "w", newline="") as f:
        cols = ["t_emg_s", "t_video_s", "left_2d", "right_2d", "left_3d", "right_3d", "left_vis", "right_vis"]
        wr = csv.DictWriter(f, fieldnames=cols); wr.writeheader(); wr.writerows(rows)
    seen = sum(1 for r in rows if r["left_2d"] != "")
    print(f"{out}: {len(rows)} frames, pose found in {seen}, video offset {offset:.2f} s")


if __name__ == "__main__":
    main()
