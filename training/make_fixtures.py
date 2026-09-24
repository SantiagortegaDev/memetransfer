"""Genera test/fixtures/locator.json.gz: imagenes sinteticas chicas + lo que
devuelve el localizador Python, para verificar que js/locator.js da lo mismo."""

import base64
import gzip
import json

import cv2
import numpy as np

import common as C
from synth import Synth

s = Synth(seed=2024)
cases = []
want = {"ok": 3, "cut": 1, "none": 1, "gap": 1}
tries = 0
while any(v > 0 for v in want.values()) and tries < 500:
    tries += 1
    gap = want["gap"] > 0 and tries % 5 == 0
    if gap:
        W, H = 640, 480
        tex, fc = s.screen_texture(None)
        M = s.pose(tex.shape, fc, W, H)
        img = cv2.warpPerspective(tex, M, (W, H), dst=s.background(W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
        img = s.camera_effects(img, cv2.warpPerspective(np.ones(tex.shape[:2], np.uint8), M, (W, H)))
    else:
        img, _, _ = s.camera_image(int(s.rng.integers(258)))
    h = round(img.shape[0] * C.LOCATE_WIDTH / img.shape[1])
    small = cv2.resize(img, (C.LOCATE_WIDTH, h), interpolation=cv2.INTER_AREA)
    q, status = C.locate_frame_detailed(small)
    key = "gap" if gap and status == "ok" else status
    if gap and status != "ok":
        continue
    if want.get(key, 0) <= 0:
        continue
    want[key] -= 1
    case = {"width": C.LOCATE_WIDTH, "height": h, "rgb": base64.b64encode(small.tobytes()).decode(), "status": status, "quad": None if q is None else q.tolist()}
    if q is not None:
        crop = C.crop_interior(small, q, 64)
        case["crop64_rgb"] = base64.b64encode(crop.tobytes()).decode()
        case["residual"] = C.gap_residual(crop)
    else:
        crop = C.center_crop(small, 64)
        case["center64_rgb"] = base64.b64encode(crop.tobytes()).decode()
    cases.append(case)
out = C.ROOT / "test" / "fixtures" / "locator.json.gz"
out.write_bytes(gzip.compress(json.dumps(cases).encode()))
print(out, len(cases), "casos", {c["status"] for c in cases}, out.stat().st_size // 1024, "KB")
