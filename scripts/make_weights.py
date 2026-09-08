"""Build src/assets/weights.png (256x256) - the importance map.

The solver minimises  (color_distance^2 x weight) + spatial_cost per cell, so
weight[i] says how hard the target cell i's own color has to be matched. To
make the output "read" as Gandhi we push weight onto the face - especially the
eyes (glasses) and lower-face (moustache/beard) - and keep the background low.
"""
from __future__ import annotations

import json
import os

import cv2
import numpy as np

LAYOUT = "scripts/raw/layout.json"
OUT = "src/assets/weights.png"


def gauss(xs: np.ndarray, ys: np.ndarray, cx: float, cy: float, sx: float, sy: float) -> np.ndarray:
    return np.exp(-(((xs - cx) / sx) ** 2 + ((ys - cy) / sy) ** 2))


def main() -> None:
    with open(LAYOUT, encoding="utf-8") as f:
        lm = json.load(f)

    T = lm["target"]
    xs, ys = np.meshgrid(np.arange(T), np.arange(T))
    fx, fy, fw, fh = lm["face"]
    fcx, fcy = lm["face_center"]
    eye_y = lm["eye_y"]
    eye_mid_x = lm["eye_mid_x"]
    span = lm["eye_half_span"]

    # base layers
    bg = 6.0
    w = np.full((T, T), bg)

    # clothing / shoulders below the face, plus side margins of the frame
    body = np.zeros((T, T))
    body[fy + fh + 4 :, :] = 65.0
    body[:, : fcx - fw] = 40.0
    body[:, fcx + fw :] = 40.0
    w = np.maximum(w, body)

    # soft mask already above the face box (head top) - slight collar at sides
    collar = gauss(xs, ys, fcx, fy + fh * 0.72, fw * 1.75, fh * 0.38) * 22.0
    w = np.maximum(w, collar)

    # main face ellipse
    face = gauss(xs, ys, fcx, fcy, fw * 0.58, fh * 0.60) * 255.0
    w = np.maximum(w, face)

    # top of head / bald dome
    dome = gauss(xs, ys, fcx, fy, fw * 0.44, fh * 0.26) * 255.0
    w = np.maximum(w, dome)

    # eyebrows (glasses brow line)
    brow = gauss(xs, ys, eye_mid_x, eye_y - fh * 0.16, fw * 0.36, fh * 0.035) * 255.0
    w = np.maximum(w, brow)

    # eyes - the iconic glasses
    for ex in (eye_mid_x - span, eye_mid_x + span):
        e = gauss(xs, ys, ex, eye_y, fw * 0.055, fh * 0.045) * 255.0
        w = np.maximum(w, e)

    # nose
    nose_y = eye_y + (fcy - eye_y) * 1.15
    nose = gauss(xs, ys, eye_mid_x, nose_y, fw * 0.05, fh * 0.05) * 255.0
    w = np.maximum(w, nose)

    # moustache / mouth line
    moustache = gauss(xs, ys, eye_mid_x, eye_y + fh * 0.32, fw * 0.16, fh * 0.04) * 255.0
    nose_bridge = gauss(xs, ys, eye_mid_x, (eye_y + fcy) / 2, fw * 0.05, fh * 0.08) * 235.0
    w = np.maximum(np.maximum(w, moustache), nose_bridge)

    # beard box below mouth to chin
    beard = gauss(xs, ys, eye_mid_x, eye_y + fh * 0.45, fw * 0.22, fh * 0.12) * 235.0
    w = np.maximum(w, beard)

    # slight low-pass so it looks hand-painted, like obamify's map
    w = cv2.GaussianBlur(w, (5, 5), 0)

    w = np.clip(w, 0, 255).astype(np.uint8)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    cv2.imwrite(OUT, w, [cv2.IMWRITE_PNG_COMPRESSION, 9])

    print(f"wrote {OUT}")
    print("face:", lm["face"], "eyes:", (eye_mid_x - span, eye_y), (eye_mid_x + span, eye_y))
    print(f"weight stats: min={w.min()} mean={w.mean():.1f} max={w.max()} "
          f"face-region mean={w[fy:fy+fh, fx:fx+fw].mean():.1f}")


if __name__ == "__main__":
    main()