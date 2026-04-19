#!/usr/bin/env python3
"""PaddleOCR runner for the Moonmoon Destiny watcher.

Reads a screenshot, optionally crops a region, runs PaddleOCR, and emits a
JSON blob to stdout that watch.js consumes. Keeping this as a one-shot
subprocess lets the Node watcher stay the orchestrator while Python handles
the heavy OCR.

Stdout JSON shape:
  {
    "attempt": int | null,
    "confidence": float,          # 0-100, scaled from paddle's 0-1
    "rawText": str,               # all detected lines joined with newlines
    "candidates": [               # every detection paddle returned
      {
        "text": str,
        "confidence": float,      # 0-100
        "box": [[x,y], ...]       # 4 corner points in the cropped image
      },
      ...
    ],
    "cropApplied": bool
  }

Usage:
  python ocr.py --image path/to/frame.png \
                --crop-json '{"x":1,"y":77,"width":28,"height":15}' \
                --crop-out path/to/latest-crop.png
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from PIL import Image
from paddleocr import PaddleOCR


_OCR: PaddleOCR | None = None


def get_ocr() -> PaddleOCR:
    """Lazily construct the PaddleOCR engine (model load is ~2-4s)."""
    global _OCR
    if _OCR is None:
        _OCR = PaddleOCR(
            use_angle_cls=False,
            lang="en",
            show_log=False,
        )
    return _OCR


def apply_crop(image: Image.Image, crop_pct: dict[str, float] | None) -> Image.Image:
    """Crop the image by percentage-of-dimension box, matching config.json."""
    if not crop_pct:
        return image
    w, h = image.size
    left = max(0, int(crop_pct["x"] / 100 * w))
    top = max(0, int(crop_pct["y"] / 100 * h))
    right = min(w, left + int(crop_pct["width"] / 100 * w))
    bottom = min(h, top + int(crop_pct["height"] / 100 * h))
    if right <= left or bottom <= top:
        return image
    return image.crop((left, top, right, bottom))


def normalize_candidates(raw_result: Any) -> list[dict[str, Any]]:
    """Flatten PaddleOCR's nested output into a simple list of candidates."""
    if not raw_result or not raw_result[0]:
        return []
    out: list[dict[str, Any]] = []
    for line in raw_result[0]:
        if not line or len(line) < 2:
            continue
        box, (text, conf) = line[0], line[1]
        out.append({
            "text": str(text or "").strip(),
            "confidence": float(conf or 0) * 100.0,
            "box": [[float(x), float(y)] for x, y in box],
        })
    return out


def select_attempt(candidates: list[dict[str, Any]]) -> tuple[int | None, float]:
    """Pick the attempt number from PaddleOCR's candidate list.

    Given a list of candidates like:
      [
        {"text": "A NEW AMERICA",     "confidence": 94.2, "box": [...]},
        {"text": "ATTEMPT #458",      "confidence": 91.0, "box": [...]},
        {"text": "moonmoon",          "confidence": 88.5, "box": [...]},
        {"text": "40",                "confidence": 62.3, "box": [...]},  # game HUD
      ]
    return (attempt_number, confidence) or (None, 0.0) if nothing looks right.

    Strategy (tiered, highest-priority match wins):
      1. Text contains "ATTEMPT" followed by a number (allowing OCR garble
         like 'H', 'A', '.', ':' between the word and digits).
      2. Text contains '#' or 'N' followed by a 1-5 digit number.
      3. Bare 1-5 digit number, only if confidence >= 70 (stricter because
         bare digits in a game scene are usually HUD noise).
    Confidence floor of 50 on tiers 1-2. Within a tier, highest conf wins.
    """
    tier1: list[tuple[int, float]] = []
    tier2: list[tuple[int, float]] = []
    tier3: list[tuple[int, float]] = []
    for c in candidates:
        txt = c["text"].upper().replace("O", "0").replace("|", "1")
        conf = c["confidence"]
        m = re.search(r"ATTEMPT[\s#:.\-HA]*(\d{1,5})", txt)
        if m and conf >= 50:
            tier1.append((int(m.group(1)), conf)); continue
        m = re.search(r"[#N][\s:.\-]*(\d{1,5})", txt)
        if m and conf >= 50:
            tier2.append((int(m.group(1)), conf)); continue
        m = re.fullmatch(r"\s*(\d{1,5})\s*", txt)
        if m and conf >= 70:
            tier3.append((int(m.group(1)), conf))
    for tier in (tier1, tier2, tier3):
        if tier:
            n, conf = max(tier, key=lambda t: t[1])
            if 1 <= n <= 100000:
                return n, conf
    return None, 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="Path to input screenshot")
    parser.add_argument("--crop-json", default="", help="JSON object with x,y,width,height percentages")
    parser.add_argument("--crop-out", default="", help="Optional path to save the cropped image for debugging")
    args = parser.parse_args()

    img_path = Path(args.image)
    if not img_path.exists():
        print(json.dumps({"error": f"image not found: {img_path}"}), file=sys.stdout)
        return 1

    crop_pct = json.loads(args.crop_json) if args.crop_json else None

    image = Image.open(img_path).convert("RGB")
    cropped = apply_crop(image, crop_pct)
    crop_applied = cropped is not image

    if args.crop_out:
        cropped.save(args.crop_out)

    import numpy as np
    arr = np.array(cropped)

    ocr = get_ocr()
    raw_result = ocr.ocr(arr, cls=False)
    candidates = normalize_candidates(raw_result)

    attempt, chosen_conf = select_attempt(candidates)

    raw_text = "\n".join(c["text"] for c in candidates)

    print(json.dumps({
        "attempt": attempt,
        "confidence": chosen_conf,
        "rawText": raw_text,
        "candidates": candidates,
        "cropApplied": crop_applied,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
