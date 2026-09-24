"""Reemplaza memes por imagenes nuevas.

Las imagenes van en una carpeta con el numero de byte como nombre (17.jpg,
203.png...) o START / END para las de control. Por cada una:
  - la convierte a JPEG (lado mayor <= 480 px, como las demas) y la guarda en
    memes/ con un nombre nuevo (asi el cache del navegador no sirve la vieja);
  - borra la imagen anterior y actualiza memes/manifest.json;
  - START / END reemplazan memes/control-start.jpg / control-end.jpg.
Despues borra los caches del dataset sintetico (training/data), que tienen las
imagenes viejas, e imprime el comando de reentrenamiento.

Uso: python training/replace_memes.py memes/nuevos [--dry-run]
"""

import argparse
import hashlib
import json
from pathlib import Path

import cv2

import common as C
from rank_memes import label, parse_target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    mpath = C.MEMES_DIR / "manifest.json"
    manifest = json.loads(mpath.read_text())
    done = []
    for p in sorted(Path(a.folder).iterdir()):
        if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
            continue
        target = parse_target(p.name)
        if target is None:
            print(f"  salto {p.name}: el nombre tiene que ser el byte (0-255), START o END")
            continue
        img = cv2.imread(str(p), cv2.IMREAD_COLOR)
        if img is None:
            print(f"  salto {p.name}: no se pudo leer")
            continue
        h, w = img.shape[:2]
        k = 480 / max(h, w)
        if k < 1:
            img = cv2.resize(img, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)
        ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        data = enc.tobytes()
        if target == C.START:
            new, old = "control-start.jpg", None
        elif target == C.END:
            new, old = "control-end.jpg", None
        else:
            new = f"r{target:03d}-{hashlib.sha1(data).hexdigest()[:6]}.jpg"
            old = manifest[target]
            if new in manifest:
                print(f"  {p.name}: identica a la actual, nada que hacer")
                continue
        print(f"  {label(target):>5}: {old or new} -> {new}")
        if not a.dry_run:
            (C.MEMES_DIR / new).write_bytes(data)
            if old:
                manifest[target] = new
                if manifest.count(old) == 0:
                    (C.MEMES_DIR / old).unlink(missing_ok=True)
        done.append(target)
    if not done:
        print("no se reemplazo nada")
        return
    if a.dry_run:
        print("(dry-run: no se cambio nada)")
        return
    mpath.write_text(json.dumps(manifest, indent=2) + "\n")
    stale = [f for f in (C.ROOT / "training" / "data").glob("*") if f.suffix in (".npz", ".npy")]
    for f in stale:
        f.unlink()
    print(f"manifest actualizado; {len(stale)} caches del dataset borrados (tenian las imagenes viejas)")
    print("Reentrenar (~30 min en CPU) enfocando los nuevos:")
    print(f"  python training/train.py --arch small --size 160 --pool 60000 --seed 3 --epochs 4 --lr 6e-4 \\\n"
          f"    --init training/runs/cpu-small160-ft/last.pt --focus {','.join(map(str, done))} --out training/runs/reemplazo")
    print("  python training/export_onnx.py training/runs/reemplazo/last.pt && python training/rank_memes.py")
    print("Y subir APP_VERSION (js/main.js) y CACHE_VERSION (sw.js) para que los telefonos bajen las imagenes nuevas.")


if __name__ == "__main__":
    main()
