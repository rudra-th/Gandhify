#!/usr/bin/env python3
"""Render the Gandhify PWA icons (192 & 512 PNG) and favicon.svg source.

Usage: .venv/Scripts/python scripts/make_icons.py
Writes to the public/ directory.
"""
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, '..', 'public'))
os.makedirs(OUT, exist_ok=True)

# palette (matches the dark theme)
BG = (0x16, 0x13, 0x0E)        # near-black warm
PAPER = (0xEF, 0xE7, 0xD3)     # light cream
ACCENT = (0xD4, 0x69, 0x2A)     # orange

for size in (192, 512):
    img = np.zeros((size, size, 3), dtype=np.uint8)
    img[:] = BG
    r = int(size * 0.22)
    cv2.rectangle(img, (0, 0), (size - 1, size - 1), BG, -1)
    cv2.circle(img, (size - r, r), r, BG, -1)  # square-cut corners not needed; plain square
    # soft rounded look via big interior fill; keep subtle inner border
    cv2.circle(img, (size - r, r), r, PAPER, 2)

    # glyph drawn with the biggest Hershey simplex glyph we can get (scaled)
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = size / 190.0
    thick = max(2, int(round(size / 160)))
    text = 'G'
    (tw, th), baseline = cv2.getTextSize(text, font, scale, thick)
    origin = ((size - tw) // 2, (size + th) // 2)
    cv2.putText(img, text, origin, font, scale, ACCENT, thick, cv2.LINE_AA)

    # underline dot (brand accent)
    dot_r = max(3, int(size * 0.02))
    cy = int(size * 0.56) + baseline // 2
    cx = (size + tw) // 2 + int(size * 0.02)
    cv2.circle(img, (cx, cy), dot_r, ACCENT, -1, cv2.LINE_AA)

    path = os.path.join(OUT, f'icon-{size}.png')
    ok = cv2.imwrite(path, img)
    assert ok, path
    print('wrote', path)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#16130e"/>
  <text x="32" y="45" font-family="Georgia,serif" font-size="40" font-weight="bold"
    text-anchor="middle" fill="#d4692a">G</text>
  <circle cx="42" cy="38" r="3" fill="#d4692a"/>
</svg>
'''
with open(os.path.join(OUT, 'icon.svg'), 'w') as f:
    f.write(svg)
print('wrote', os.path.join(OUT, 'icon.svg'))