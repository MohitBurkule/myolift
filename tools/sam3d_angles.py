#!/usr/bin/env python3
"""
Elbow angles from an experiment video with Meta's SAM 3D Body (occlusion-robust 3D body fit).

  ~/src/sam-3d-body/.venv/bin/python tools/sam3d_angles.py <experiment dir> [--fps 5] [--out file.csv]
      [--ckpt ~/models/sam-3d-body-dinov3/model.ckpt] [--overlay dir] [--fov 78]

Per sampled frame: one person box (MediaPipe pose bbox if found, else the whole frame), camera
intrinsics from the given vertical FOV, body-only inference. Writes t_video_s, t_emg_s, left, right
(elbow flexion in degrees from the 3D keypoints: 0 = straight), the 3D and 2D shoulder/elbow/wrist
keypoints, and conf (visibility of the arm in the image: fraction of the 2D chain inside the frame).
"""
import argparse, csv, json, math, os, sys, time

import cv2
import numpy as np
import torch

SAM = os.path.expanduser("~/src/sam-3d-body")
sys.path.insert(0, SAM)
from sam_3d_body import SAM3DBodyEstimator, load_sam_3d_body  # noqa: E402

# the DINOv3 backbone code comes via torch.hub from GitHub; use a local clone instead
# (architecture code only, pretrained=False: the weights are in the SAM 3D Body checkpoint)
_hub_load = torch.hub.load
DINO = os.path.expanduser("~/src/dinov3")


def _local_hub(repo, *args, **kw):
    if repo == "facebookresearch/dinov3" and os.path.isdir(DINO):
        kw["source"] = "local"
        return _hub_load(DINO, *args, **kw)
    return _hub_load(repo, *args, **kw)


torch.hub.load = _local_hub

J = {"left": (5, 7, 62), "right": (6, 8, 41)}  # shoulder, elbow, wrist (MHR70)


def flexion(a, b, c):
    v1, v2 = a - b, c - b
    n = np.linalg.norm(v1) * np.linalg.norm(v2)
    if n == 0:
        return float("nan")
    return 180.0 - math.degrees(math.acos(max(-1.0, min(1.0, float(v1 @ v2) / n))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--fps", type=float, default=5)
    ap.add_argument("--out")
    ap.add_argument("--ckpt", default=os.path.expanduser("~/models/sam-3d-body-dinov3/model.ckpt"))
    ap.add_argument("--mhr", default=os.path.expanduser("~/models/sam-3d-body-dinov3/assets/mhr_model.pt"))
    ap.add_argument("--overlay")
    ap.add_argument("--overlay_every", type=int, default=0)
    ap.add_argument("--fov", type=float, default=78.0, help="vertical field of view, degrees")
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--end", type=float, default=1e9)
    a = ap.parse_args()
    meta = json.load(open(os.path.join(a.dir, "experiment.json")))
    offset = (meta.get("video") or {}).get("offsetS", 0.0)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if dev.type == "cpu":
        # the upstream code hard-codes "cuda" in a few places; run everything on the CPU instead
        import sam_3d_body.sam_3d_body_estimator as E
        _rt = E.recursive_to
        E.recursive_to = lambda x, d: _rt(x, "cpu")
        torch.Tensor.cuda = lambda self, *r, **k: self
        torch.set_num_threads(os.cpu_count() or 8)
    # load on the CPU, then move to the GPU (the backbone is already fp16/bf16 per model_config USE_FP16;
    # other apps share the 8 GB GPU, so avoid materialising fp32 weights on it)
    model, cfg = load_sam_3d_body(a.ckpt, device=torch.device("cpu"), mhr_path=a.mhr)
    if dev.type == "cuda":
        # body-only inference: drop the hand decoder/head (~0.9 GB) so it fits next to other GPU apps
        for n in ("head_pose_hand", "decoder_hand"):
            if hasattr(model, n):
                setattr(model, n, torch.nn.Identity())
        model.to(dev)
    est = SAM3DBodyEstimator(sam_3d_body_model=model, model_cfg=cfg)
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
        mpm = os.path.join(os.path.dirname(__file__), "pose_landmarker_full.task")
        if not os.path.exists(mpm):
            mpm = "/tmp/claude-1000/-home-mohit/3b339da3-a486-4d8d-8451-d60feabcc24b/scratchpad/pose_landmarker_full.task"
        det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=mpm)))
    except Exception as e:
        print("no mediapipe box:", e); det = None
    cap = cv2.VideoCapture(os.path.join(a.dir, "video.mp4"))
    rows, nxt, times = [], a.start, []
    if a.overlay:
        os.makedirs(a.overlay, exist_ok=True)
    k = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        tv = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if tv < nxt or tv > a.end:
            if tv > a.end:
                break
            continue
        nxt = tv + 1.0 / a.fps
        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        box = np.array([[0, 0, w - 1, h - 1]], dtype=np.float32)
        if det is not None:
            r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            if r.pose_landmarks:
                xs = [p.x * w for p in r.pose_landmarks[0]]; ys = [p.y * h for p in r.pose_landmarks[0]]
                x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
                pad = 0.15 * max(x1 - x0, y1 - y0)
                box = np.array([[max(0, x0 - pad), max(0, y0 - pad), min(w - 1, x1 + pad), min(h - 1, y1 + pad)]], dtype=np.float32)
        f = 0.5 * h / math.tan(math.radians(a.fov) / 2)
        K = np.array([[[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]]], dtype=np.float32)
        t0 = time.time()
        with torch.no_grad():
            out = est.process_one_image(rgb, bboxes=box, cam_int=torch.from_numpy(K), inference_type="body")
        times.append(time.time() - t0)
        row = {"t_video_s": round(tv, 3), "t_emg_s": round(tv + offset, 3)}
        if out:
            o = out[0]
            k3, k2 = np.asarray(o["pred_keypoints_3d"], float), np.asarray(o["pred_keypoints_2d"], float)
            for side, (s, e, wr) in J.items():
                row[side] = round(flexion(k3[s], k3[e], k3[wr]), 1)
                inside = [0 <= k2[j, 0] < w and 0 <= k2[j, 1] < h for j in (s, e, wr)]
                row[f"{side}_conf"] = round(sum(inside) / 3, 2)
                for nm, j in (("sh", s), ("el", e), ("wr", wr)):
                    row[f"{side}_{nm}_x"], row[f"{side}_{nm}_y"] = round(k2[j, 0], 1), round(k2[j, 1], 1)
                    row[f"{side}_{nm}_X"], row[f"{side}_{nm}_Y"], row[f"{side}_{nm}_Z"] = (round(float(v), 4) for v in k3[j])
            if a.overlay and a.overlay_every and k % a.overlay_every == 0:
                im = frame.copy()
                for side, col in (("left", (255, 120, 40)), ("right", (40, 90, 255))):
                    pts = [(int(row[f"{side}_{nm}_x"]), int(row[f"{side}_{nm}_y"])) for nm in ("sh", "el", "wr")]
                    for p, q in zip(pts, pts[1:]):
                        cv2.line(im, p, q, col, 5)
                    for p in pts:
                        cv2.circle(im, p, 9, col, -1)
                    cv2.putText(im, f"{side[0].upper()} {row[side]:.0f}", (20, 60 if side == 'left' else 110), cv2.FONT_HERSHEY_SIMPLEX, 1.6, col, 4)
                cv2.putText(im, f"t={tv:.1f}s", (20, h - 30), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
                cv2.imwrite(os.path.join(a.overlay, f"f{tv:06.1f}.jpg"), cv2.resize(im, (w // 2, h // 2)))
        rows.append(row)
        k += 1
    outp = a.out or os.path.join(a.dir, "sam3d_angles.csv")
    cols = sorted({c for r in rows for c in r}, key=lambda c: (c not in ("t_video_s", "t_emg_s", "left", "right", "left_conf", "right_conf"), c))
    with open(outp, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=cols); wr.writeheader(); wr.writerows(rows)
    print(f"{outp}: {len(rows)} frames, {np.mean(times[1:]) if len(times) > 1 else float('nan'):.2f} s/frame")


if __name__ == "__main__":
    main()
