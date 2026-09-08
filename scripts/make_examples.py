"""Download public-domain portraits and normalise them to 256x256 PNGs for eval."""
from __future__ import annotations

import os
import urllib.request

from PIL import Image

EXAMPLES = [
    (
        "https://upload.wikimedia.org/wikipedia/commons/6/66/Einstein_1921_by_F_Schmutzer.jpg",
        "einstein",
    ),
    (
        "https://upload.wikimedia.org/wikipedia/commons/a/a1/Alan_Turing_Aged_16.jpg",
        "turing",
    ),
    (
        "https://upload.wikimedia.org/wikipedia/commons/c/c8/Marie_Curie_c._1920s.jpg",
        "curie",
    ),
]

OUT = "scripts/sources"
SIZE = 256


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    os.makedirs("scripts/cache", exist_ok=True)
    for url, name in EXAMPLES:
        raw = f"scripts/cache/{name}.jpg"
        if not os.path.exists(raw):
            req = urllib.request.Request(url, headers={"User-Agent": "gandhify/0.1 (local dev)"})
            with urllib.request.urlopen(req, timeout=60) as r, open(raw, "wb") as f:
                f.write(r.read())
        img = Image.open(raw).convert("RGB")
        w, h = img.size
        side = min(w, h)
        img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
        img.save(os.path.join(OUT, f"{name}.png"))
        print(f"wrote scripts/sources/{name}.png")


if __name__ == "__main__":
    main()