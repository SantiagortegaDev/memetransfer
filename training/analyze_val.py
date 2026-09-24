"""Desglose de errores del modelo ONNX sobre el set de validacion sintetico.

Separa las aceptaciones falsas en:
  - meme -> otro meme: el error que de verdad dana al protocolo
  - NONE -> meme: casi siempre mezclas/transiciones donde el meme dominante
    se ve (inofensivo: cae en el slot de ese mismo meme o en un gap)
y lista las clases con mas errores.

Uso: python training/analyze_val.py [model/memes.onnx]
"""

import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort

import common as C
from export_onnx import softmax, to_nchw
from train import ACCEPT_MARGIN, ACCEPT_P, make_val


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else str(C.ROOT / "model" / "memes.onnx")
    meta = json.loads((Path(model).parent / "labels.json").read_text())
    size = meta["input_size"]
    X, Y = make_val(size, 4000, 999, C.ROOT / "training" / "data" / f"val_{size}.npz")
    X, Y = X.numpy(), Y.numpy()
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    sess = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    P = np.concatenate([softmax(sess.run(None, {"input": to_nchw(X[i : i + 64])})[0]) for i in range(0, len(X), 64)])
    o = np.argsort(-P, 1)
    pred, p1, p2 = o[:, 0], P[np.arange(len(P)), o[:, 0]], P[np.arange(len(P)), o[:, 1]]
    acc = (p1 >= ACCEPT_P) & (p1 - p2 >= ACCEPT_MARGIN) & (pred != C.NONE)
    meme = Y != C.NONE
    mm = acc & meme & (pred != Y)
    nm = acc & ~meme
    out = {
        "n": len(Y),
        "meme_samples": int(meme.sum()),
        "accepted_correct": int((acc & (pred == Y)).sum()),
        "false_meme_to_other_meme": int(mm.sum()),
        "false_none_to_meme": int(nm.sum()),
        "far_meme_to_meme_over_meme_frames": float(mm.sum() / meme.sum()),
        "precision_accepted_on_meme_frames": float((acc & meme & (pred == Y)).sum() / max(1, (acc & meme).sum())),
        "accept_rate_meme": float((acc & meme).sum() / meme.sum()),
        "start_end": {n: {"n": int((Y == c).sum()), "acc": float((pred[Y == c] == c).mean())} for n, c in (("START", C.START), ("END", C.END))},
        "worst_classes": Counter(Y[meme & (pred != Y)].tolist()).most_common(10),
        "confusions": Counter(zip(Y[mm].tolist(), pred[mm].tolist())).most_common(10),
    }
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
