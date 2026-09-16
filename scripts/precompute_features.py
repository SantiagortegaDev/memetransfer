#!/usr/bin/env python3
"""
Precalcula, para cada una de las 256 imagenes de datos (memes/manifest.json)
mas las 2 imagenes de control (memes/control-start.jpg, control-end.jpg),
sus keypoints ORB y descriptores binarios, y los serializa en un unico
archivo binario (memes/features.bin) + un indice JSON (memes/features.json)
con offsets/counts. Asi el receptor no tiene que correr deteccion ORB sobre
las 258 imagenes de referencia en cada sesion - solo las carga y las
compara contra el frame de camara capturado.

IMPORTANTE: los parametros de ORB (nfeatures, scaleFactor, nlevels, etc.)
tienen que coincidir EXACTO con los que usa js/vision.js al extraer el
descriptor del frame capturado - si no, los descriptores no son
comparables entre si con distancia de Hamming.

Uso:
    pip install opencv-python-headless
    python3 scripts/precompute_features.py
"""
import json
import struct
from pathlib import Path

import cv2
import numpy as np

# Debe coincidir con js/vision.js
CANONICAL_SIZE = 480
BACKGROUND_GRAY = 128
ORB_NFEATURES = 500


def make_orb():
    return cv2.ORB_create(nfeatures=ORB_NFEATURES)


def fit_contain(img, size, background):
    """Redimensiona `img` para que quepa entera dentro de un cuadrado
    `size`x`size` (como CSS object-fit: contain), centrada sobre un fondo
    gris - replicando exactamente como se ve un meme en pantalla dentro de
    .meme-screen (aspect-ratio 1/1, object-fit: contain, background gris).
    """
    h, w = img.shape[:2]
    scale = min(size / w, size / h)
    new_w, new_h = round(w * scale), round(h * scale)
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((size, size), background, dtype=np.uint8)
    x0 = (size - new_w) // 2
    y0 = (size - new_h) // 2
    canvas[y0 : y0 + new_h, x0 : x0 + new_w] = resized
    return canvas


def extract_features(orb, image_path):
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit(f"No se pudo leer {image_path}")
    canonical = fit_contain(img, CANONICAL_SIZE, BACKGROUND_GRAY)
    keypoints, descriptors = orb.detectAndCompute(canonical, None)
    if descriptors is None:
        descriptors = np.zeros((0, 32), dtype=np.uint8)
    points = np.array([kp.pt for kp in keypoints], dtype=np.float32) if keypoints else np.zeros((0, 2), dtype=np.float32)
    return points, descriptors


def main():
    project_root = Path(__file__).resolve().parent.parent
    memes_dir = project_root / "memes"
    manifest = json.loads((memes_dir / "manifest.json").read_text())
    if len(manifest) != 256:
        raise SystemExit(f"Se esperaban 256 memes en el manifest, hay {len(manifest)}")

    orb = make_orb()

    entries = [{"index": i, "path": memes_dir / filename} for i, filename in enumerate(manifest)]
    entries.append({"index": "start", "path": memes_dir / "control-start.jpg"})
    entries.append({"index": "end", "path": memes_dir / "control-end.jpg"})

    index = []
    blob = bytearray()
    for entry in entries:
        points, descriptors = extract_features(orb, entry["path"])
        count = len(points)
        offset = len(blob)
        blob += struct.pack(f"<{count * 2}f", *points.flatten().tolist())
        blob += descriptors.tobytes()
        index.append(
            {
                "index": entry["index"],
                "count": count,
                "pointsOffset": offset,
                "pointsLength": count * 2 * 4,
                "descriptorsOffset": offset + count * 2 * 4,
                "descriptorsLength": count * 32,
            }
        )
        if isinstance(entry["index"], int) and (entry["index"] + 1) % 32 == 0:
            print(f"  {entry['index'] + 1}/256")

    (memes_dir / "features.bin").write_bytes(bytes(blob))
    (memes_dir / "features.json").write_text(
        json.dumps({"canonicalSize": CANONICAL_SIZE, "orbNFeatures": ORB_NFEATURES, "entries": index})
    )

    counts = [e["count"] for e in index]
    print(f"Listo: {memes_dir}/features.bin ({len(blob) / 1024:.0f} KB), features.json")
    print(f"Keypoints por imagen: min={min(counts)} max={max(counts)} promedio={sum(counts) / len(counts):.0f}")


if __name__ == "__main__":
    main()
