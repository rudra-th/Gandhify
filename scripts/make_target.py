"""Build src/assets/target.png (256x256) from the raw 1931 studio portrait.

The square window is placed so that Gandhi's eyes land around eye_y_frac of
the frame height and are horizontally centered - mimicking how a user's own
face sits after the app centre-crops their photo. Geometry is stored to
scripts/raw/layout.json for make_weights.py to reuse.
"""
from __future__ import annotations

import json
import os

import cv2
import numpy as np

import geometry

RAW = "scripts/raw/gandhi-1931.jpg"
OUT = "src/assets/target.png"
LAYOUT = "scripts/raw/layout.json"

WIDTH = 2620
HEIGHT = 3270
CROP = 2620
CROP_Y0 = (HEIGHT - CROP) // 2  # crop window y offset inside the full image
TARGET = 256

EYE_Y_FRAC = 0.38   # where the eye line lands in the target frame
FACE_SCALE = 2.0    # frame height / detected face height


def main() -> None:
    gray = geometry.load_crop_gray()
    lm = geometry.landmarks()
    fx, fy, fw, fh = lm["face"]
    eye_y = lm["eye_y"] + CROP_Y0
    eye_mid_x = lm["eye_mid_x"]

    s = int(round(FACE_SCALE * fh))
    y0 = int(np.clip(eye_y - EYE_Y_FRAC * s, 0, HEIGHT - s))
    x0 = int(np.clip(eye_mid_x - s / 2, 0, WIDTH - s))

    img = cv2.imread(RAW)
    square = img[y0 : y0 + s, x0 : x0 + s]
    out = cv2.resize(square, (TARGET, TARGET), interpolation=cv2.INTER_LANCZOS4)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    cv2.imwrite(OUT, out, [cv2.IMWRITE_PNG_COMPRESSION, 9])

    scale = TARGET / s
    layout = {
        "frame_side": s,
        "x0": int(x0),
        "y0": int(y0),
        "target": TARGET,
        "face": [
            int((fx - x0) * scale),
            int((fy + CROP_Y0 - y0) * scale),
            int(fw * scale),
            int(fh * scale),
        ],
        "eye_y": int((eye_y - y0) * scale),
        "eye_mid_x": int((eye_mid_x - x0) * scale),
        "eye_half_span": int(lm["eye_half_span"] * scale),
        "face_center": [
            int((lm["face_center"][0] - x0) * scale),
            int((lm["face_center"][1] + CROP_Y0 - y0) * scale),
        ],
    }
    with open(LAYOUT, "w", encoding="utf-8") as f:
        json.dump(layout, f, indent=2)

    print("layout:", json.dumps(layout))
    print(f"wrote {OUT} ({TARGET}x{TARGET})")


if __name__ == "__main__":
    main()