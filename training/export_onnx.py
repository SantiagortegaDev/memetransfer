"""Exporta un checkpoint a ONNX para el navegador.

  1. ONNX fp32 (opset 17), entrada "input" [1,3,S,S] RGB en [0,1], salida "logits" [1,259]
  2. Variantes mas chicas:
     - int8 estatica (QDQ, por canal) calibrada con muestras sinteticas. Con
       MobileNetV3 (hardswish + SE) suele colapsar; queda por si otro modelo la tolera.
     - "fp16w": pesos guardados en fp16 + Cast a fp32 (ORT lo pliega al
       cargar): mitad de tamano, mismo calculo en fp32.
  3. Evalua todas con onnxruntime sobre el set de validacion y elige la mas
     chica que pierda <= --max-drop puntos de precision (si no, fp32)
  4. Escribe model/memes.onnx + model/labels.json (clases, archivos, tamano, metricas)

Uso:
  python training/export_onnx.py training/runs/cpu-small160/best.pt
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

import common as C
from train import ACCEPT_MARGIN, ACCEPT_P, build_model, make_val


def softmax(x):
    e = np.exp(x - x.max(1, keepdims=True))
    return e / e.sum(1, keepdims=True)


def to_nchw(u8: np.ndarray) -> np.ndarray:
    return (u8.astype(np.float32) / 255.0).transpose(0, 3, 1, 2).copy()


def onnx_eval(path: Path, X: np.ndarray, Y: np.ndarray) -> dict:
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    probs = []
    for i in range(len(X)):
        probs.append(softmax(sess.run(None, {name: to_nchw(X[i : i + 1])})[0]))
    P = np.concatenate(probs)
    order = np.argsort(-P, 1)
    pred = order[:, 0]
    p1 = P[np.arange(len(P)), pred]
    p2 = P[np.arange(len(P)), order[:, 1]]
    accepted = (p1 >= ACCEPT_P) & (p1 - p2 >= ACCEPT_MARGIN) & (pred != C.NONE)
    correct = pred == Y
    # latencia de 1 frame, 1 hilo (parecido al navegador sin COOP/COEP)
    so1 = ort.SessionOptions()
    so1.intra_op_num_threads = 1
    s1 = ort.InferenceSession(str(path), so1, providers=["CPUExecutionProvider"])
    x = to_nchw(X[:1])
    for _ in range(5):
        s1.run(None, {name: x})
    t = time.time()
    for _ in range(30):
        s1.run(None, {name: x})
    return {
        "acc": float(correct.mean()),
        "acc_meme": float(correct[Y != C.NONE].mean()),
        "acc_none": float(correct[Y == C.NONE].mean()),
        "precision_accepted": float((correct & accepted).sum() / max(1, accepted.sum())),
        "false_accept_rate": float((accepted & ~correct).sum() / len(Y)),
        "accept_rate_meme": float((accepted & (Y != C.NONE)).sum() / max(1, (Y != C.NONE).sum())),
        "latency_ms_1thread": (time.time() - t) / 30 * 1000,
        "size_kb": path.stat().st_size // 1024,
    }


def fp16_weights(src: Path, dst: Path):
    """Guarda los pesos en fp16 y agrega un Cast a fp32 delante de cada uno."""
    m = onnx.load(str(src))
    g = m.graph
    new, casts = [], []
    for init in list(g.initializer):
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.float32 and arr.size > 16:
            h = numpy_helper.from_array(arr.astype(np.float16), init.name + "_fp16")
            new.append(h)
            casts.append(helper.make_node("Cast", [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + "_cast"))
            g.initializer.remove(init)
    g.initializer.extend(new)
    for c in reversed(casts):
        g.node.insert(0, c)
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))


class Reader(CalibrationDataReader):
    def __init__(self, X: np.ndarray, name: str):
        self.X, self.name, self.i = X, name, 0

    def get_next(self):
        if self.i >= len(self.X):
            return None
        x = to_nchw(self.X[self.i : self.i + 1])
        self.i += 1
        return {self.name: x}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("--out-dir", default=str(C.ROOT / "model"))
    ap.add_argument("--data-dir", default=str(C.ROOT / "training" / "data"))
    ap.add_argument("--val", type=int, default=4000)
    ap.add_argument("--calib", type=int, default=400)
    ap.add_argument("--max-drop", type=float, default=0.005)
    ap.add_argument("--format", choices=["auto", "int8", "fp16w", "fp32"], default="auto")
    a = ap.parse_args()

    ck = torch.load(a.checkpoint, map_location="cpu")
    size, arch = ck["size"], ck["arch"]
    model = build_model(arch, pretrained=False)
    model.load_state_dict(ck["model"])
    model.eval()

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    work = Path(a.data_dir) / "export"
    work.mkdir(parents=True, exist_ok=True)
    fp32 = work / "memes_fp32.onnx"
    dummy = torch.zeros(1, 3, size, size)
    torch.onnx.export(model, dummy, str(fp32), input_names=["input"], output_names=["logits"], dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17, dynamo=False)
    onnx.checker.check_model(onnx.load(str(fp32)))

    Xv, Yv = make_val(size, a.val, 999, Path(a.data_dir) / f"val_{size}.npz")
    Xv, Yv = Xv.numpy(), Yv.numpy()
    with torch.no_grad():
        ref = model(torch.from_numpy(to_nchw(Xv[:8]))).numpy()
    s = ort.InferenceSession(str(fp32), providers=["CPUExecutionProvider"])
    got = s.run(None, {"input": to_nchw(Xv[:8])})[0]
    assert np.abs(ref - got).max() < 1e-3, "el ONNX no coincide con PyTorch"

    results = {"fp32": onnx_eval(fp32, Xv, Yv)}
    print("fp32", json.dumps(results["fp32"]))
    files = {"fp32": fp32}
    if a.format in ("auto", "int8"):
        pre = work / "memes_pre.onnx"
        quant_pre_process(str(fp32), str(pre))
        # calibracion con muestras distintas de la validacion
        Xc, _ = make_val(size, a.calib, 4242, Path(a.data_dir) / f"calib_{size}.npz")
        files["int8"] = work / "memes_int8.onnx"
        quantize_static(
            str(pre),
            str(files["int8"]),
            Reader(Xc.numpy(), "input"),
            quant_format=QuantFormat.QDQ,
            per_channel=True,
            weight_type=QuantType.QInt8,
            activation_type=QuantType.QUInt8,
        )
    if a.format in ("auto", "fp16w"):
        files["fp16w"] = work / "memes_fp16w.onnx"
        fp16_weights(fp32, files["fp16w"])
    for name in ("int8", "fp16w"):
        if name in files:
            results[name] = onnx_eval(files[name], Xv, Yv)
            print(name, json.dumps(results[name]))

    def ok(name):
        r, b = results[name], results["fp32"]
        return b["precision_accepted"] - r["precision_accepted"] <= a.max_drop and b["acc"] - r["acc"] <= 2 * a.max_drop

    if a.format == "auto":
        fmt = next((n for n in ("int8", "fp16w") if n in results and ok(n)), "fp32")
    else:
        fmt = a.format
    chosen = files[fmt]
    target = out / "memes.onnx"
    target.write_bytes(chosen.read_bytes())

    manifest = json.loads((C.MEMES_DIR / "manifest.json").read_text())
    labels = {
        "model": "memes.onnx",
        "format": fmt,
        "arch": f"mobilenet_v3_{arch}",
        "input_size": size,
        "input": "RGB [0,1] NCHW float32; normalizacion ImageNet dentro del grafo",
        "classes": C.class_labels(),
        "files": manifest + ["control-start.jpg", "control-end.jpg"],
        "accept": {"p": ACCEPT_P, "margin": ACCEPT_MARGIN},
        "trained_epochs": ck.get("epoch", 0) + 1,
        "exported": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "synthetic_val": results[fmt],
        "synthetic_val_all": results,
    }
    (out / "labels.json").write_text(json.dumps(labels, indent=1, ensure_ascii=False))
    print(f"-> {target} ({fmt}, {target.stat().st_size // 1024} KB) + labels.json")


if __name__ == "__main__":
    main()
