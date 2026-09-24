"""Precision por frame sobre un VIDEO REAL grabado con el telefono apuntando
al modo Calibrar del emisor (los 258 memes en orden, en loop).

Cada frame pasa por la misma cadena que el navegador: localizador ->
recorte -> gap -> modelo ONNX -> aceptacion (p >= 0.6 y margen >= 0.3).
Las etiquetas salen del orden conocido: los frames se agrupan en slots
(separados por los gaps grises) y la clase esperada de cada slot es
(ancla + indice) mod 258, con el ancla votada entre los slots leidos, igual
que js/calibration.js. Con --truth (JSON de make_video.py) se usan las
etiquetas reales por frame.

Criterio de aceptacion (plan): >= 98% de frames correctos entre los
aceptados y < 1% de aceptaciones falsas.

Uso:
  python training/eval_video.py grabacion.mp4
  python training/eval_video.py grabacion.mp4 --export-crops real_crops/   # para fine-tuning
  python training/eval_video.py cal.webm --truth cal.json
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

import common as C

ACCEPT_P = 0.6
ACCEPT_MARGIN = 0.3
N_CAL = 258
WORK_WIDTH = 2 * C.LOCATE_WIDTH


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


def process(frame_bgr, sess, size):
    """Misma cadena que js/frame-reader.js. Devuelve dict de observacion + recorte."""
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    h = round(rgb.shape[0] * WORK_WIDTH / rgb.shape[1])
    h -= h % 2
    work = cv2.resize(rgb, (WORK_WIDTH, h), interpolation=cv2.INTER_AREA)
    q, status = C.locate_frame_detailed(work)
    crop = C.crop_interior(work, q, size) if q is not None else C.center_crop(work, size)
    res = C.gap_residual(crop)
    obs = {"status": status, "residual": res, "gap": False, "cls": None, "top1": None, "p": 0.0, "margin": 0.0}
    if res < C.GAP_RESIDUAL_MAX:
        obs["gap"] = True
        return obs, crop
    x = (crop.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
    p = softmax(sess.run(None, {sess.get_inputs()[0].name: x})[0][0])
    o = np.argsort(-p)
    top1, p1, p2 = int(o[0]), float(p[o[0]]), float(p[o[1]])
    obs.update(top1=top1, p=p1, margin=p1 - p2)
    if top1 == C.NONE and p1 >= 0.5 and res < C.GAP_RESIDUAL_NONE_MAX:
        obs["gap"] = True
    elif p1 >= ACCEPT_P and p1 - p2 >= ACCEPT_MARGIN:
        obs["cls"] = top1
    return obs, crop


def slots_from(frames):
    """Agrupa frames no-gap consecutivos en slots (sin las correcciones por tiempo del JS)."""
    slots, cur = [], []
    for i, f in enumerate(frames):
        if f["gap"]:
            if cur:
                slots.append(cur)
            cur = []
        else:
            cur.append(i)
    if cur:
        slots.append(cur)
    out = []
    for idx in slots:
        votes = Counter()
        for i in idx:
            c = frames[i]["cls"]
            if c is not None and c != C.NONE:
                votes[c] += frames[i]["p"]
        out.append({"frames": idx, "cls": votes.most_common(1)[0][0] if votes else None})
    return [s for s in out if s["cls"] is not None or len(s["frames"]) >= 2]


def label_by_order(frames, window=24):
    slots = slots_from(frames)
    recent = []
    for k, s in enumerate(slots):
        if s["cls"] is not None and s["cls"] < N_CAL:
            recent.append((s["cls"] - k) % N_CAL)
            recent = recent[-window:]
        cnt = Counter(recent).most_common(1)
        if cnt and cnt[0][1] >= 2:
            exp = (cnt[0][0] + k) % N_CAL
            for i in s["frames"]:
                frames[i]["label"] = exp
    return slots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--model", default=str(C.ROOT / "model" / "memes.onnx"))
    ap.add_argument("--truth", help="JSON de make_video.py con la etiqueta real de cada frame")
    ap.add_argument("--fps", type=float, default=0, help="submuestrear a estos frames/s (0 = todos)")
    ap.add_argument("--report", default="eval_report.json")
    ap.add_argument("--export-crops", help="guarda los recortes etiquetados en DIR/<clase>/ para fine-tuning")
    a = ap.parse_args()

    labels = json.loads((Path(a.model).parent / "labels.json").read_text())
    size = labels["input_size"]
    sess = ort.InferenceSession(a.model, providers=["CPUExecutionProvider"])
    cap = cv2.VideoCapture(a.video)
    if not cap.isOpened():
        raise SystemExit(f"no se pudo abrir {a.video}")
    vfps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(vfps / a.fps)) if a.fps else 1
    frames, crops = [], []
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        if i % step == 0:
            obs, crop = process(fr, sess, size)
            obs["frame"] = i
            frames.append(obs)
            crops.append(crop if a.export_crops else None)
        i += 1
    print(f"{len(frames)} frames analizados de {i}")

    if a.truth:
        truth = json.loads(Path(a.truth).read_text())["frames"]
        for f in frames:
            t = truth[f["frame"]]
            if t["symbol"] is not None and not t["mixed"]:
                f["label"] = t["symbol"]
            elif t["symbol"] is None and not t["mixed"]:
                f["label"] = "gap"
    else:
        label_by_order(frames)

    meme = [f for f in frames if isinstance(f.get("label"), int)]
    accepted = [f for f in meme if f["cls"] is not None and f["cls"] != C.NONE]
    correct = [f for f in accepted if f["cls"] == f["label"]]
    wrong = [f for f in accepted if f["cls"] != f["label"]]
    gaps = [f for f in frames if f.get("label") == "gap"]
    precision = len(correct) / max(1, len(accepted))
    far = len(wrong) / max(1, len(meme))
    per = defaultdict(lambda: {"frames": 0, "accepted": 0, "correct": 0, "confused": Counter()})
    for f in meme:
        d = per[f["label"]]
        d["frames"] += 1
        if f["cls"] is not None and f["cls"] != C.NONE:
            d["accepted"] += 1
            if f["cls"] == f["label"]:
                d["correct"] += 1
            else:
                d["confused"][f["cls"]] += 1
    problems = sorted(
        ({"cls": k, **{kk: v for kk, v in d.items() if kk != "confused"}, "confused": d["confused"].most_common(3)} for k, d in per.items() if d["accepted"] > d["correct"] or d["accepted"] < 0.3 * d["frames"]),
        key=lambda x: (x["correct"] / max(1, x["accepted"]), x["accepted"] / max(1, x["frames"])),
    )
    report = {
        "video": a.video,
        "frames": len(frames),
        "meme_frames_labeled": len(meme),
        "classes_seen": len(per),
        "accept_rate": len(accepted) / max(1, len(meme)),
        "precision_accepted": precision,
        "false_accept_rate": far,
        "gap_recall": (sum(f["gap"] for f in gaps) / len(gaps)) if gaps else None,
        "criterion": {"precision>=0.98": precision >= 0.98, "false_accept<0.01": far < 0.01},
        "problems": problems[:40],
    }
    Path(a.report).write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "problems"}, indent=1))
    print(f"memes problematicos: {[p['cls'] for p in problems[:15]]}")
    print("CUMPLE el criterio" if all(report["criterion"].values()) else "NO cumple el criterio: grabar mas video real y hacer fine-tuning (train.py --real)")

    if a.export_crops:
        out = Path(a.export_crops)
        n = 0
        for f, crop in zip(frames, crops):
            lab = f.get("label")
            if crop is None or lab is None:
                continue
            cls = C.NONE if lab == "gap" else lab
            d = out / str(cls)
            d.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(d / f"{Path(a.video).stem}_{f['frame']:06d}.jpg"), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
            n += 1
        print(f"{n} recortes etiquetados en {out}")


if __name__ == "__main__":
    main()
