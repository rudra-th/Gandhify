"""Shared geometry helpers for building the Gandhify target + weights assets.

Everything works in coordinates of the square center-crop of the raw portrait
(a 2620x2620 region cut from the 2620x3270 original).
"""
from __future__ import annotations

import cv2
import numpy as np

SRC = "scripts/raw/gandhi-1931.jpg"
CROP = 2620  # side of the square center-crop of the raw portrait

_face_cascade = None
_glasses_eye_cascade = None


def load_crop_gray() -> np.ndarray:
    img = cv2.imread(SRC)
    h, w = img.shape[:2]
    side = min(w, h)
    x0 = (w - side) // 2
    y0 = (h - side) // 2
    crop = img[y0 : y0 + side, x0 : x0 + side]
    gray = cv2.equalizeHist(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))
    return gray


def detect_face(gray: np.ndarray) -> tuple[int, int, int, int]:
    global _face_cascade
    if _face_cascade is None:
        _face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
    faces = _face_cascade.detectMultiScale(gray, 1.12, 5, minSize=(60, 60))
    if len(faces) == 0:
        raise RuntimeError("no frontal face detected")
    fx, fy, fw, fh = max(faces, key=lambda f: int(f[2]) * int(f[3]))
    return int(fx), int(fy), int(fw), int(fh)


def detect_eyes(gray: np.ndarray, fx: int, fy: int, fw: int, fh: int) -> list[tuple[int, int]]:
    """Eye centres (x, y) in crop coordinates; prefers the glasses cascade."""
    global _glasses_eye_cascade
    roi = gray[fy : fy + fh, fx : fx + fw]
    candidates: list[tuple[int, int]] = []
    for name in ("haarcascade_eye_tree_eyeglasses.xml", "haarcascade_eye.xml"):
        c = cv2.CascadeClassifier(cv2.data.haarcascades + name)
        for scale, neigh, mins in ((1.05, 3, (15, 15)), (1.1, 4, (12, 12)), (1.03, 2, (10, 10))):
            eyes = c.detectMultiScale(roi, scale, neigh, minSize=mins)
            if len(eyes) >= 2:
                for (ex, ey, ew, eh) in eyes[:6]:
                    candidates.append((fx + ex + ew // 2, fy + ey + eh // 2))
                break
        if len(candidates) >= 2:
            break
    return candidates[:4]


def landmarks() -> dict:
    """Detect the face + eye geometry in the center-crop. Returns pixels."""
    gray = load_crop_gray()
    fx, fy, fw, fh = detect_face(gray)
    eyes = detect_eyes(gray, fx, fy, fw, fh)
    face_cx = fx + fw // 2
    face_cy = fy + fh // 2

    # validate detected eyes: two plausible points, eyebrow-ish height,
    # horizontally separated inside the face box
    use_eyes = False
    if len(eyes) >= 2:
        ys = [e[1] for e in eyes]
        xs = sorted(e[0] for e in eyes)
        in_face = all(fy + fh * 0.20 <= y <= fy + fh * 0.62 for y in ys)
        sep = xs[-1] - xs[0]
        ok_y = abs(ys[0] - ys[-1]) <= 0.30 * fw
        ok_x = 0.30 * fw <= sep <= 0.82 * fw
        use_eyes = in_face and ok_y and ok_x

    if use_eyes:
        ey = int(round(float(np.mean(ys))))
        mid_x = (xs[0] + xs[-1]) // 2
        half_span = max(1, sep // 2)
    else:
        # safe symmetric fallback from face-box proportions
        ey = fy + int(fh * 0.42)
        mid_x = face_cx
        half_span = max(1, int(fw * 0.26))

    return {
        "face": (fx, fy, fw, fh),
        "face_center": (face_cx, face_cy),
        "eye_y": ey,
        "eye_mid_x": mid_x,
        "eye_half_span": half_span,
        "eyes_detected": use_eyes,
    }