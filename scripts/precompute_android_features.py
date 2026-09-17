#!/usr/bin/env python3
"""
Precalcula, para los 256 memes (memes/manifest.json) mas las 2 imagenes de
control (memes/control-start.jpg, memes/control-end.jpg), (1) su embedding
visual via MobileNetV3Small (TensorFlow Lite) y (2) sus keypoints+
descriptores ORB, y los serializa junto con el propio modelo .tflite en
android/app/src/main/assets/ para que la app Android los cargue sin tener
que recalcular nada en el dispositivo.

IMPORTANTE: CANONICAL_SIZE y los parametros de ORB tienen que coincidir
EXACTO con los que usa la app Android (ver
android/app/src/main/java/com/memetransfer/receiver/vision/ScreenIsolator.kt
y OrbVerifier.kt) - si no, los descriptores no son comparables entre si por
distancia de Hamming, y los embeddings no son comparables por coseno.

Uso (requiere Python 3.12 - TensorFlow todavia no soporta 3.14 al momento
de escribir esto):
    python3.12 -m venv .venv-android
    .venv-android/bin/pip install tensorflow-cpu opencv-python-headless numpy pillow
    .venv-android/bin/python scripts/precompute_android_features.py
"""
import json
import struct
from pathlib import Path

import cv2
import numpy as np
import tensorflow as tf

# Deben coincidir con el runtime Android (ScreenIsolator.kt/OrbVerifier.kt)
CANONICAL_SIZE = 480
BACKGROUND_GRAY = 128
ORB_NFEATURES = 500
EMBED_INPUT_SIZE = 224  # tamano de entrada esperado por MobileNetV3Small


def make_orb():
    return cv2.ORB_create(
        nfeatures=ORB_NFEATURES,
        scaleFactor=1.2,
        nlevels=8,
        edgeThreshold=31,
        firstLevel=0,
        WTA_K=2,
        scoreType=cv2.ORB_HARRIS_SCORE,
        patchSize=31,
        fastThreshold=20,
    )


def fit_contain(img_gray, size, background):
    """Redimensiona `img_gray` para que quepa entera dentro de un cuadrado
    `size`x`size` (como CSS object-fit: contain), centrada sobre un fondo
    gris - replicando exactamente como se ve un meme en pantalla dentro de
    .meme-screen (aspect-ratio 1/1, object-fit: contain, background gris)."""
    h, w = img_gray.shape[:2]
    scale = min(size / w, size / h)
    new_w, new_h = round(w * scale), round(h * scale)
    resized = cv2.resize(img_gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((size, size), background, dtype=np.uint8)
    x0 = (size - new_w) // 2
    y0 = (size - new_h) // 2
    canvas[y0 : y0 + new_h, x0 : x0 + new_w] = resized
    return canvas


def extract_orb(orb, canonical_gray):
    keypoints, descriptors = orb.detectAndCompute(canonical_gray, None)
    if descriptors is None:
        descriptors = np.zeros((0, 32), dtype=np.uint8)
    points = np.array([kp.pt for kp in keypoints], dtype=np.float32) if keypoints else np.zeros((0, 2), dtype=np.float32)
    return points, descriptors


def build_embedder():
    """Construye MobileNetV3Small (ImageNet, feature vector antes de la
    cabeza de clasificacion) y lo convierte a TFLite float32."""
    model = tf.keras.applications.MobileNetV3Small(
        include_top=False, pooling="avg", weights="imagenet", input_shape=(EMBED_INPUT_SIZE, EMBED_INPUT_SIZE, 3)
    )
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    tflite_model = converter.convert()
    return tflite_model


def embed_with_tflite(interpreter, canonical_gray_or_rgb):
    """Corre el modelo TFLite sobre una imagen (se convierte a RGB, se
    redimensiona a 224x224, se preprocesa igual que
    tf.keras.applications.mobilenet_v3.preprocess_input) y devuelve el
    vector de embedding (576-d)."""
    if canonical_gray_or_rgb.ndim == 2:
        rgb = cv2.cvtColor(canonical_gray_or_rgb, cv2.COLOR_GRAY2RGB)
    else:
        rgb = canonical_gray_or_rgb
    resized = cv2.resize(rgb, (EMBED_INPUT_SIZE, EMBED_INPUT_SIZE), interpolation=cv2.INTER_AREA)
    batch = np.expand_dims(resized.astype(np.float32), axis=0)
    batch = tf.keras.applications.mobilenet_v3.preprocess_input(batch)

    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    interpreter.set_tensor(input_details[0]["index"], batch)
    interpreter.invoke()
    embedding = interpreter.get_tensor(output_details[0]["index"])[0]
    return embedding.astype(np.float32)


def main():
    project_root = Path(__file__).resolve().parent.parent
    memes_dir = project_root / "memes"
    assets_dir = project_root / "android" / "app" / "src" / "main" / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((memes_dir / "manifest.json").read_text())
    if len(manifest) != 256:
        raise SystemExit(f"Se esperaban 256 memes en el manifest, hay {len(manifest)}")

    print("Construyendo y convirtiendo MobileNetV3Small a TFLite...")
    tflite_model = build_embedder()
    (assets_dir / "model_embedder.tflite").write_bytes(tflite_model)
    embed_dim_probe = tf.lite.Interpreter(model_content=tflite_model)
    embed_dim_probe.allocate_tensors()
    embed_dim = embed_dim_probe.get_output_details()[0]["shape"][-1]
    print(f"  modelo listo, embedding dim={embed_dim}, {len(tflite_model)/1024:.0f} KB")

    orb = make_orb()

    entries = [{"index": i, "path": memes_dir / filename} for i, filename in enumerate(manifest)]
    entries.append({"index": "start", "path": memes_dir / "control-start.jpg"})
    entries.append({"index": "end", "path": memes_dir / "control-end.jpg"})

    index_meta = []
    orb_blob = bytearray()
    embeddings = np.zeros((len(entries), embed_dim), dtype=np.float32)

    for i, entry in enumerate(entries):
        img_bgr = cv2.imread(str(entry["path"]), cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise SystemExit(f"No se pudo leer {entry['path']}")
        img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        canonical_gray = fit_contain(img_gray, CANONICAL_SIZE, BACKGROUND_GRAY)

        points, descriptors = extract_orb(orb, canonical_gray)
        count = len(points)
        offset = len(orb_blob)
        orb_blob += struct.pack(f"<{count * 2}f", *points.flatten().tolist())
        orb_blob += descriptors.tobytes()

        # el embedding se calcula sobre la version "contain" en color (RGB),
        # no en escala de grises, para no perder la informacion de color que
        # MobileNetV3 fue entrenado a usar.
        canonical_bgr = fit_contain_color(img_bgr, CANONICAL_SIZE, BACKGROUND_GRAY)
        canonical_rgb = cv2.cvtColor(canonical_bgr, cv2.COLOR_BGR2RGB)
        embeddings[i] = embed_with_tflite(embed_dim_probe, canonical_rgb)

        index_meta.append(
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

    (assets_dir / "reference_orb.bin").write_bytes(bytes(orb_blob))
    embeddings.tofile(assets_dir / "reference_embeddings.bin")
    (assets_dir / "reference_meta.json").write_text(
        json.dumps(
            {
                "canonicalSize": CANONICAL_SIZE,
                "orbNFeatures": ORB_NFEATURES,
                "embeddingDim": int(embed_dim),
                "entries": index_meta,
            }
        )
    )

    counts = [e["count"] for e in index_meta]
    print(f"Listo: {assets_dir}")
    print(f"  reference_orb.bin: {len(orb_blob)/1024:.0f} KB")
    print(f"  reference_embeddings.bin: {embeddings.nbytes/1024:.0f} KB ({len(entries)}x{embed_dim} float32)")
    print(f"  Keypoints por imagen: min={min(counts)} max={max(counts)} promedio={sum(counts)/len(counts):.0f}")


def fit_contain_color(img_bgr, size, background):
    h, w = img_bgr.shape[:2]
    scale = min(size / w, size / h)
    new_w, new_h = round(w * scale), round(h * scale)
    resized = cv2.resize(img_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((size, size, 3), background, dtype=np.uint8)
    x0 = (size - new_w) // 2
    y0 = (size - new_h) // 2
    canvas[y0 : y0 + new_h, x0 : x0 + new_w] = resized
    return canvas


if __name__ == "__main__":
    main()
