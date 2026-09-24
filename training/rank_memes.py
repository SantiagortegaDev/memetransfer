"""Ranking de memes problematicos (y chequeo de candidatos a reemplazo).

Modo ranking (por defecto): para cada una de las 258 clases genera N capturas
sinteticas (mismo simulador que el entrenamiento, semilla fija) y mide con el
modelo actual:
  - acierto              top-1 correcto
  - aceptado_ok          aceptado (p>=0.6, margen>=0.3) Y correcto: lo que usa el receptor
  - confusion_peligrosa  aceptado como OTRO meme (el error que dana al protocolo)
  - margen               p1 - p2 medio
y ademas propiedades del meme en si, que no dependen del modelo:
  - textura              residuo de gap tras desenfocar y bajar contraste; bajo = se
                         parece al gris del gap
  - parecido             similitud con el meme mas parecido (embedding del modelo
                         y miniatura 32x32 en gris)

Modo candidatos (--candidates DIR): evalua imagenes nuevas ANTES de reemplazar
(textura y parecido con los 257 restantes), sin reentrenar.

Uso:
  python training/rank_memes.py                       # -> docs/MEMES_PROBLEMATICOS.md + json
  python training/rank_memes.py --candidates memes/nuevos
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import re
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch

import common as C
from export_onnx import softmax, to_nchw
from synth import Synth

ACCEPT_P, ACCEPT_MARGIN = 0.6, 0.3


def _gen(args):
    cls, n, size, seed = args
    s = Synth(size=size, seed=seed)
    out = []
    tries = 0
    while len(out) < n and tries < 4 * n:
        tries += 1
        x, y = s.sample(cls)
        if y == cls:
            out.append(x)
    return cls, np.stack(out)


def clean_crop(img_rgb: np.ndarray, size: int) -> np.ndarray:
    """Como lo ve el modelo en condiciones ideales: estirado al cuadrado."""
    return cv2.resize(img_rgb, (size, size), interpolation=cv2.INTER_AREA)


def degraded_texture(img_rgb: np.ndarray, size: int) -> float:
    """Residuo de gap despues de un desenfoque fuerte y contraste a la mitad."""
    c = clean_crop(img_rgb, size).astype(np.float32)
    c = cv2.GaussianBlur(c, (0, 0), 2.5)
    c = (c - c.mean()) * 0.5 + c.mean()
    return C.gap_residual(np.clip(c, 0, 255).astype(np.uint8))


def thumb(img_rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(cv2.resize(img_rgb, (32, 32), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32).ravel()
    g -= g.mean()
    return g / (np.linalg.norm(g) + 1e-6)


class Embedder:
    """Features de la penultima capa del checkpoint PyTorch (o de los logits ONNX si no hay checkpoint)."""

    def __init__(self, ckpt: Path | None, sess, size):
        self.size, self.sess, self.net = size, sess, None
        if ckpt and ckpt.exists():
            from train import build_model

            ck = torch.load(ckpt, map_location="cpu")
            m = build_model(ck["arch"], pretrained=False)
            m.load_state_dict(ck["model"])
            m.eval()
            self.net = m

    def __call__(self, crops: np.ndarray) -> np.ndarray:
        x = to_nchw(crops)
        if self.net is not None:
            with torch.no_grad():
                t = torch.from_numpy(x)
                t = (t - self.net.mean) / self.net.std
                n = self.net.net
                f = n.avgpool(n.features(t)).flatten(1)
                f = n.classifier[1](n.classifier[0](f))  # Linear + Hardswish
                f = f.numpy()
        else:
            f = self.sess.run(None, {"input": x})[0]
        return f / (np.linalg.norm(f, axis=1, keepdims=True) + 1e-6)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(C.ROOT / "model" / "memes.onnx"))
    ap.add_argument("--ckpt", default=str(C.ROOT / "training" / "runs" / "cpu-small160-ft" / "last.pt"))
    ap.add_argument("--n", type=int, default=60, help="capturas sinteticas por meme")
    ap.add_argument("--seed", type=int, default=777)
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--out", default=str(C.ROOT / "docs" / "MEMES_PROBLEMATICOS.md"))
    ap.add_argument("--json", default=str(C.ROOT / "docs" / "memes_ranking.json"))
    ap.add_argument("--from-json", action="store_true", help="solo regenera el markdown desde --json")
    ap.add_argument("--candidates", help="carpeta con imagenes candidatas (nombre = byte, START o END: 17.jpg, START.png)")
    a = ap.parse_args()

    if a.from_json:
        rows = json.loads(Path(a.json).read_text())
        classify(rows)
        rows.sort(key=lambda r: -r["riesgo"])
        Path(a.json).write_text(json.dumps(rows, indent=1, ensure_ascii=False))
        write_markdown(rows, a, Path(a.out))
        contact_sheet([r for r in rows if r["nivel"] != "bien"] or rows[: a.top], C.load_class_images(), Path(a.out).with_name("memes_problematicos.jpg"))
        print("->", a.out)
        return
    meta = json.loads((Path(a.model).parent / "labels.json").read_text())
    size = meta["input_size"]
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    sess = ort.InferenceSession(a.model, so, providers=["CPUExecutionProvider"])
    files = C.class_files()
    images = C.load_class_images()
    emb = Embedder(Path(a.ckpt), sess, size)
    E = emb(np.stack([clean_crop(im, size) for im in images]))
    T = np.stack([thumb(im) for im in images])

    if a.candidates:
        check_candidates(Path(a.candidates), images, files, E, T, emb, sess, size)
        return

    # ---- capturas sinteticas por clase
    jobs = [(c, a.n, size, a.seed * 1000 + c) for c in range(258)]
    rows = []
    with mp.Pool() as pool:
        for cls, X in pool.imap_unordered(_gen, jobs, chunksize=4):
            P = np.concatenate([softmax(sess.run(None, {"input": to_nchw(X[i : i + 64])})[0]) for i in range(0, len(X), 64)])
            o = np.argsort(-P, 1)
            pred, p1 = o[:, 0], P[np.arange(len(P)), o[:, 0]]
            p2 = P[np.arange(len(P)), o[:, 1]]
            acc = (p1 >= ACCEPT_P) & (p1 - p2 >= ACCEPT_MARGIN) & (pred != C.NONE)
            conf = {}
            for q in pred[pred != cls]:
                conf[int(q)] = conf.get(int(q), 0) + 1
            rows.append(
                {
                    "cls": cls,
                    "file": files[cls],
                    "n": len(X),
                    "acierto": float((pred == cls).mean()),
                    "aceptado_ok": float((acc & (pred == cls)).mean()),
                    "confusion_peligrosa": float((acc & (pred != cls)).mean()),
                    "margen": float((p1 - p2)[pred == cls].mean()) if (pred == cls).any() else 0.0,
                    "confusiones": sorted(conf.items(), key=lambda kv: -kv[1])[:3],
                }
            )
            print(f"\r  {len(rows)}/258", end="", flush=True)
    print()

    # ---- propiedades del meme
    Se = E @ E.T
    St = T @ T.T
    np.fill_diagonal(Se, -1)
    np.fill_diagonal(St, -1)
    for r in rows:
        c = r["cls"]
        r["textura"] = degraded_texture(images[c], size)
        j = int(np.argmax(Se[c]))
        r["parecido_modelo"] = float(Se[c, j])
        r["mas_parecido"] = j
        r["parecido_miniatura"] = float(St[c].max())
        r["mas_parecido_miniatura"] = int(np.argmax(St[c]))
    classify(rows)
    rows.sort(key=lambda r: -r["riesgo"])
    Path(a.json).write_text(json.dumps(rows, indent=1, ensure_ascii=False))
    write_markdown(rows, a, Path(a.out))
    contact_sheet([r for r in rows if r["nivel"] != "bien"] or rows[: a.top], images, Path(a.out).with_name("memes_problematicos.jpg"))
    print(f"-> {a.out}, {a.json}")
    for r in rows[: a.top]:
        print(f"{label(r['cls']):>6}  {r['file']:<18} aceptado_ok {r['aceptado_ok']:.2f}  peligrosa {r['confusion_peligrosa']:.3f}  textura {r['textura']:.1f}  parecido {r['parecido_modelo']:.2f}  {', '.join(r['motivos'])}")


def classify(rows):
    """Motivos, riesgo y nivel (reemplazar / opcional / bien) de cada meme."""
    by = {r["cls"]: r for r in rows}
    for r in rows:
        reasons = []
        if r["aceptado_ok"] < 0.92:
            reasons.append("se lee poco")
        if r["confusion_peligrosa"] > 0:
            reasons.append("se confunde con otro")
        if r["textura"] < 4.0:
            reasons.append("poca textura (parece gris)")
        if r["parecido_modelo"] > 0.85:
            reasons.append(f"muy parecido a {label(r['mas_parecido'])}")
        elif r["parecido_miniatura"] > 0.9:
            reasons.append(f"casi igual a {label(r['mas_parecido_miniatura'])}")
        r["motivos"] = reasons
        r["riesgo"] = (
            (1 - r["aceptado_ok"])
            + 5 * r["confusion_peligrosa"]
            + max(0.0, (6.0 - r["textura"]) / 20)
            + max(0.0, r["parecido_modelo"] - 0.75)
            + max(0.0, r["parecido_miniatura"] - 0.9)
        )
        bad = r["aceptado_ok"] < 0.92 or r["confusion_peligrosa"] > 0 or r["parecido_modelo"] > 0.85 or r["parecido_miniatura"] > 0.9
        r["nivel"] = "reemplazar" if bad else ("opcional" if r["aceptado_ok"] < 0.95 else "bien")
    # de un par de duplicados alcanza con reemplazar uno: el de mas riesgo
    for r in rows:
        only_dup = r["nivel"] == "reemplazar" and all(m.startswith(("casi igual", "muy parecido")) for m in r["motivos"])
        if not only_dup:
            continue
        twin = by.get(r["mas_parecido_miniatura"] if r["parecido_miniatura"] > 0.9 else r["mas_parecido"])
        if twin and twin["nivel"] == "reemplazar" and (twin["riesgo"], -twin["cls"]) > (r["riesgo"], -r["cls"]):
            r["nivel"] = "opcional"
            r["motivos"] = [f"duplicado de {label(twin['cls'])}: alcanza con reemplazar uno de los dos"]


def label(c: int) -> str:
    return {C.START: "START", C.END: "END", C.NONE: "NONE"}.get(c, str(c))


def write_markdown(rows, a, out: Path):
    ok = [r for r in rows if r["aceptado_ok"] >= 0.95 and not r["confusion_peligrosa"]]
    lines = [
        "# Memes problemáticos",
        "",
        f"Generado por `training/rank_memes.py` con el modelo actual: {a.n} capturas sintéticas por meme",
        "(mismo simulador que el entrenamiento, semilla fija, así que se puede comparar antes y después).",
        "",
        f"- Memes con ≥95% leídos bien y sin confusiones: **{len(ok)}/258**.",
        f"- Promedio de «aceptado y correcto»: **{np.mean([r['aceptado_ok'] for r in rows]):.1%}**.",
        "",
        "**Columnas:** *leído OK* = % de capturas que el receptor acepta con la clase correcta;",
        "*confusión* = % aceptado como **otro** meme (el error grave); *textura* = qué tan poco se parece",
        "al gris del gap después de desenfocar (menos de 4 es riesgoso); *parecido* = similitud con el",
        "meme más parecido según el modelo (más de 0.85 es riesgoso).",
        "",
    ]
    for nivel, titulo, texto in (
        ("reemplazar", "Reemplazar", "fallan seguido o se confunden con otro meme."),
        ("opcional", "Opcional", "funcionan, pero por debajo del resto; reemplazarlos es una mejora menor."),
    ):
        sel = [r for r in rows if r["nivel"] == nivel]
        lines += [f"## {titulo} ({len(sel)})", "", f"Estos {texto}", ""]
        if not sel:
            lines += ["Ninguno.", ""]
            continue
        lines += [
            "| Byte | Meme | Archivo | Leído OK | Confusión | Textura | Parecido (con) | Se confunde con | Motivos |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for r in sel:
            conf = ", ".join(f"{label(k)} ×{v}" for k, v in r["confusiones"]) or "—"
            lines.append(
                f"| {label(r['cls'])} | <img src=\"../memes/{r['file']}\" width=\"64\"> | `{r['file']}` | {r['aceptado_ok']:.0%} | {r['confusion_peligrosa']:.1%} | {r['textura']:.1f} | {r['parecido_modelo']:.2f} ({label(r['mas_parecido'])}) | {conf} | {', '.join(r['motivos']) or '—'} |"
            )
        lines.append("")
    lines += [
        f"El resto ({sum(r['nivel'] == 'bien' for r in rows)} memes) se lee bien en ≥95% de las capturas; entre ellos las diferencias son ruido estadístico.",
        "«NONE» en *se confunde con* significa que el modelo dijo «no hay meme» (se pierde ese frame, no es grave);",
        "un número o START/END es un error de verdad.",
        "",
        "### Qué hace bueno a un meme para esto",
        "",
        "- Mucho contraste y colores variados; que ocupe todo el cuadro (se estira a cuadrado).",
        "- Evitar dibujos de línea fina sobre fondo blanco y fotos apagadas o de un solo tono: con",
        "  desenfoque y reflejo se parecen al gris del gap o a la pantalla vacía.",
        "- Que no sea otra versión de un meme que ya está (misma plantilla, mismos colores).",
    ]
    lines += [
        "",
        "## Cómo reemplazarlos",
        "",
        "1. Pon las imágenes nuevas en `memes/nuevos/`, con el **número de byte** como nombre",
        "   (`17.jpg`, `203.png`…) o `START.jpg` / `END.jpg` para las de control.",
        "2. Antes de reemplazar, revisa que sean buenas candidatas (no necesita reentrenar):",
        "   `python training/rank_memes.py --candidates memes/nuevos`",
        "   Buscan: mucha textura y contraste, colores variados, y que no se parezcan a ningún otro meme.",
        "3. Reemplaza: `python training/replace_memes.py memes/nuevos` (copia los archivos y actualiza `memes/manifest.json`).",
        "4. Reentrena enfocando los memes nuevos (≈30 min en CPU) y exporta:",
        "   `python training/train.py --arch small --size 160 --pool 60000 --seed 3 --epochs 4 --lr 6e-4 --init training/runs/cpu-small160-ft/last.pt --focus <bytes separados por coma> --out training/runs/reemplazo`",
        "   `python training/export_onnx.py training/runs/reemplazo/last.pt`",
        "5. Vuelve a correr `python training/rank_memes.py` y compara con este archivo.",
    ]
    out.write_text("\n".join(lines) + "\n")


def contact_sheet(rows, images, path: Path):
    tiles = []
    for r in rows:
        t = cv2.resize(images[r["cls"]], (150, 150), interpolation=cv2.INTER_AREA)
        t = cv2.copyMakeBorder(t, 0, 24, 0, 0, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        cv2.putText(t, f"{label(r['cls'])} {r['aceptado_ok']:.0%}", (4, 168), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
        tiles.append(t)
    while len(tiles) % 5:
        tiles.append(np.full_like(tiles[0], 255))
    sheet = np.vstack([np.hstack(tiles[i : i + 5]) for i in range(0, len(tiles), 5)])
    cv2.imwrite(str(path), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])


def parse_target(name: str) -> int | None:
    stem = Path(name).stem.upper()
    if stem == "START":
        return C.START
    if stem == "END":
        return C.END
    if re.fullmatch(r"\d{1,3}", stem) and int(stem) < 256:
        return int(stem)
    return None


def check_candidates(folder: Path, images, files, E, T, emb, sess, size):
    cands = sorted(p for p in folder.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
    if not cands:
        raise SystemExit(f"no hay imagenes en {folder}")
    print(f"{'archivo':<14} {'reemplaza':>9} {'textura':>8} {'parecido':>9} {'miniatura':>9}  veredicto")
    for p in cands:
        target = parse_target(p.name)
        bgr = cv2.imread(str(p), cv2.IMREAD_COLOR)
        if bgr is None:
            print(f"{p.name:<14} no se pudo leer")
            continue
        img = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        tex = degraded_texture(img, size)
        e = emb(clean_crop(img, size)[None])[0]
        sims = E @ e
        ts = T @ thumb(img)
        if target is not None:
            sims[target] = -1  # se compara contra los que quedan
            ts[target] = -1
        j = int(np.argmax(sims))
        problems = []
        if tex < 6.0:
            problems.append("poca textura")
        if sims[j] > 0.85:
            problems.append(f"se parece a {label(j)} ({files[j]})")
        if ts.max() > 0.8:
            problems.append("miniatura casi igual a otro meme")
        if target is None:
            problems.append("nombre invalido (usa el byte: 17.jpg, o START/END)")
        verdict = "OK" if not problems else "REVISAR: " + "; ".join(problems)
        print(f"{p.name:<14} {label(target) if target is not None else '?':>9} {tex:8.1f} {sims[j]:9.2f} {ts.max():9.2f}  {verdict}")


if __name__ == "__main__":
    main()
