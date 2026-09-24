"""Entrena el clasificador de 259 clases (256 bytes + START + END + NONE).

Dos modos de datos:
  --pool N   pre-genera N muestras sinteticas en disco (memmap) usando todos
             los nucleos y despues entrena varias epocas sobre ellas. Es lo
             mas rapido en CPU.
  (sin --pool) genera las muestras en linea con DataLoader + workers: datos
             siempre nuevos, ideal con GPU (Colab).

La normalizacion de ImageNet va DENTRO del modelo exportado: el navegador
solo tiene que pasar RGB en [0, 1] (NCHW float32).

Ejemplos:
  # CPU (contenedor): MobileNetV3-Small a 160 px
  python training/train.py --arch small --size 160 --pool 100000 --epochs 10
  # Colab T4: MobileNetV3-Large a 224 px, datos en linea
  python training/train.py --arch large --size 224 --epochs 20 --samples-per-epoch 50000 --workers 8 --batch 128
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision

import common as C
from synth import Synth

ACCEPT_P = 0.6
ACCEPT_MARGIN = 0.3


class Normalized(nn.Module):
    """Envuelve la red: entrada RGB [0,1] NCHW -> logits. Incluye la normalizacion."""

    def __init__(self, net: nn.Module):
        super().__init__()
        self.net = net
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def forward(self, x):
        return self.net((x - self.mean) / self.std)


def build_model(arch: str, pretrained: bool = True) -> nn.Module:
    if arch == "small":
        w = torchvision.models.MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        net = torchvision.models.mobilenet_v3_small(weights=w)
    elif arch == "large":
        w = torchvision.models.MobileNet_V3_Large_Weights.IMAGENET1K_V2 if pretrained else None
        net = torchvision.models.mobilenet_v3_large(weights=w)
    else:
        raise ValueError(arch)
    net.classifier[3] = nn.Linear(net.classifier[3].in_features, C.NUM_CLASSES)
    return Normalized(net)


# ----------------------------------------------------------------------------- datos


def _gen_chunk(args):
    path, lpath, start, count, size, seed, total, focus = args
    X = np.lib.format.open_memmap(path, mode="r+")
    Y = np.lib.format.open_memmap(lpath, mode="r+")
    s = Synth(size=size, seed=seed, focus=focus)
    for i in range(start, start + count):
        X[i], Y[i] = s.sample()
    X.flush()
    Y.flush()
    return count


def generate_pool(path: Path, n: int, size: int, seed: int, workers: int, focus=None):
    """Genera (o reutiliza) un pool de n muestras en disco."""
    lpath = path.with_suffix(".labels.npy")
    if path.exists() and lpath.exists():
        X = np.load(path, mmap_mode="r")
        if X.shape == (n, size, size, 3):
            print(f"pool existente: {path} ({n} muestras)")
            return
    path.parent.mkdir(parents=True, exist_ok=True)
    np.lib.format.open_memmap(path, mode="w+", dtype=np.uint8, shape=(n, size, size, 3))
    np.lib.format.open_memmap(lpath, mode="w+", dtype=np.int16, shape=(n,))
    chunk = 500
    jobs = [(str(path), str(lpath), s, min(chunk, n - s), size, seed * 100003 + s, n, focus) for s in range(0, n, chunk)]
    t = time.time()
    done = 0
    with mp.Pool(workers) as pool:
        for c in pool.imap_unordered(_gen_chunk, jobs):
            done += c
            if done % 5000 < chunk:
                rate = done / (time.time() - t)
                print(f"  pool {done}/{n}  {rate:.0f} muestras/s  ETA {(n - done) / rate / 60:.1f} min", flush=True)


class PoolDataset(torch.utils.data.Dataset):
    def __init__(self, path: Path):
        self.X = np.load(path, mmap_mode="r")
        self.Y = np.load(path.with_suffix(".labels.npy"), mmap_mode="r")

    def __len__(self):
        return len(self.Y)

    def __getitem__(self, i):
        return torch.from_numpy(np.array(self.X[i])), int(self.Y[i])


class RealCrops(torch.utils.data.Dataset):
    """Recortes reales etiquetados (eval_video.py --export-crops): DIR/<clase>/*.jpg"""

    def __init__(self, root: Path, size: int, repeat: int = 1):
        import cv2

        self.items = []
        for d in sorted(Path(root).iterdir()):
            if d.is_dir() and d.name.isdigit():
                for f in sorted(d.glob("*.jpg")):
                    img = cv2.cvtColor(cv2.imread(str(f)), cv2.COLOR_BGR2RGB)
                    self.items.append((cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA), int(d.name)))
        self.repeat = repeat
        self.rng = np.random.default_rng()
        print(f"recortes reales: {len(self.items)} de {root} (x{repeat})")

    def __len__(self):
        return len(self.items) * self.repeat

    def __getitem__(self, i):
        img, y = self.items[i % len(self.items)]
        return torch.from_numpy(np.ascontiguousarray(np.rot90(img, int(self.rng.integers(4))))), y


class OnlineDataset(torch.utils.data.IterableDataset):
    def __init__(self, size: int, n: int, seed: int, real: RealCrops | None = None, p_real: float = 0.0, focus=None):
        self.size, self.n, self.seed, self.real, self.p_real, self.focus = size, n, seed, real, p_real, focus

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid, nw = (info.id, info.num_workers) if info else (0, 1)
        s = Synth(size=self.size, seed=self.seed * 7919 + wid + int(time.time() * 1000) % 100000, focus=self.focus)
        for _ in range(self.n // nw):
            if self.real is not None and len(self.real.items) and s.rng.random() < self.p_real:
                yield self.real[int(s.rng.integers(len(self.real.items)))]
                continue
            x, y = s.sample()
            yield torch.from_numpy(x), y


def to_input(batch_u8: torch.Tensor) -> torch.Tensor:
    """uint8 NHWC -> float NCHW [0,1]"""
    return batch_u8.permute(0, 3, 1, 2).float().div_(255.0)


def light_augment(x: torch.Tensor) -> torch.Tensor:
    """Aumento barato en batch encima del sintetico: brillo/contraste/color."""
    n = x.shape[0]
    b = 1 + 0.15 * (torch.rand(n, 1, 1, 1) * 2 - 1)
    c = 1 + 0.15 * (torch.rand(n, 1, 1, 1) * 2 - 1)
    ch = 1 + 0.06 * (torch.rand(n, 3, 1, 1) * 2 - 1)
    m = x.mean(dim=(1, 2, 3), keepdim=True)
    return ((x - m) * c + m).mul_(b * ch).clamp_(0, 1)


# ----------------------------------------------------------------------------- eval


@torch.no_grad()
def evaluate(model, X: torch.Tensor, Y: torch.Tensor, dev=torch.device("cpu"), batch: int = 256) -> dict:
    model.eval()
    probs = []
    for i in range(0, len(X), batch):
        probs.append(F.softmax(model(to_input(X[i : i + batch]).to(dev)), 1).cpu())
    P = torch.cat(probs)
    top2 = P.topk(2, 1)
    pred = top2.indices[:, 0]
    p1 = top2.values[:, 0]
    margin = p1 - top2.values[:, 1]
    accepted = (p1 >= ACCEPT_P) & (margin >= ACCEPT_MARGIN)
    is_meme = Y != C.NONE
    acc_pred_meme = accepted & (pred != C.NONE)
    correct = pred == Y
    out = {
        "acc": correct.float().mean().item(),
        "acc_meme": correct[is_meme].float().mean().item(),
        "acc_none": correct[~is_meme].float().mean().item() if (~is_meme).any() else float("nan"),
        # criterio de aceptacion: de los frames aceptados como meme, cuantos son correctos
        "precision_accepted": (correct & acc_pred_meme).sum().item() / max(1, acc_pred_meme.sum().item()),
        "false_accept_rate": (acc_pred_meme & ~correct).sum().item() / len(Y),
        "accept_rate_meme": (acc_pred_meme & is_meme).sum().item() / max(1, is_meme.sum().item()),
    }
    return out


def make_val(size: int, n: int, seed: int, cache: Path):
    if cache.exists():
        d = np.load(cache)
        if d["X"].shape[1] == size and len(d["Y"]) == n:
            return torch.from_numpy(d["X"]), torch.from_numpy(d["Y"].astype(np.int64))
    tmp = cache.with_suffix(".pool.npy")
    generate_pool(tmp, n, size, seed, max(1, os.cpu_count() or 1))
    X = np.array(np.load(tmp, mmap_mode="r"))
    Y = np.array(np.load(tmp.with_suffix(".labels.npy"), mmap_mode="r"))
    np.savez(cache, X=X, Y=Y)
    tmp.unlink()
    tmp.with_suffix(".labels.npy").unlink()
    return torch.from_numpy(X), torch.from_numpy(Y.astype(np.int64))


# ----------------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", choices=["small", "large"], default="small")
    ap.add_argument("--size", type=int, default=160)
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--wd", type=float, default=0.02)
    ap.add_argument("--label-smoothing", type=float, default=0.1)
    ap.add_argument("--pool", type=int, default=0, help="pre-generar N muestras (modo CPU)")
    ap.add_argument("--samples-per-epoch", type=int, default=50000, help="modo en linea")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--val", type=int, default=4000)
    ap.add_argument("--data-dir", default=str(C.ROOT / "training" / "data"))
    ap.add_argument("--out", default=str(C.ROOT / "training" / "runs" / "latest"))
    ap.add_argument("--init", help="checkpoint para continuar (fine-tuning)")
    ap.add_argument("--real", help="carpeta con recortes reales etiquetados (eval_video.py --export-crops)")
    ap.add_argument("--focus", default="", help="clases a sobremuestrear, separadas por coma (bytes, START=256, END=257)")
    ap.add_argument("--real-fraction", type=float, default=0.25, help="fraccion aproximada de muestras reales por epoca")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-minutes", type=float, default=0, help="corta el entrenamiento a este tiempo (0 = sin limite)")
    a = ap.parse_args()

    torch.manual_seed(a.seed)
    torch.set_num_threads(a.threads)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    data = Path(a.data_dir)
    print(f"device={dev} arch={a.arch} size={a.size}", flush=True)

    focus = [int(x) for x in a.focus.split(",") if x.strip()]
    Xv, Yv = make_val(a.size, a.val, 999, data / f"val_{a.size}.npz")

    if a.pool:
        tag = "_f" + "-".join(map(str, focus[:6])) + (f"-n{len(focus)}" if len(focus) > 6 else "") if focus else ""
        pool_path = data / f"pool_{a.size}_{a.pool}_s{a.seed}{tag}.npy"
        generate_pool(pool_path, a.pool, a.size, a.seed + 1, a.workers + 1, focus)
        ds = PoolDataset(pool_path)
        if a.real:
            real = RealCrops(Path(a.real), a.size)
            if len(real.items):
                real.repeat = max(1, int(a.real_fraction * len(ds) / max(1, len(real.items))))
                ds = torch.utils.data.ConcatDataset([ds, real])
        loader = torch.utils.data.DataLoader(ds, batch_size=a.batch, shuffle=True, num_workers=0, drop_last=True)
        steps_per_epoch = len(loader)
    else:
        real = RealCrops(Path(a.real), a.size) if a.real else None
        ds = OnlineDataset(a.size, a.samples_per_epoch, a.seed, real, a.real_fraction, focus)
        loader = torch.utils.data.DataLoader(ds, batch_size=a.batch, num_workers=a.workers, persistent_workers=a.workers > 0, prefetch_factor=4 if a.workers else None)
        steps_per_epoch = a.samples_per_epoch // a.batch

    model = build_model(a.arch).to(dev)
    if a.init:
        model.load_state_dict(torch.load(a.init, map_location="cpu")["model"])
        print("init desde", a.init)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=a.wd)
    total = a.epochs * steps_per_epoch
    warm = max(1, min(500, total // 20))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    crit = nn.CrossEntropyLoss(label_smoothing=a.label_smoothing)

    best = -1.0
    t0 = time.time()
    log = open(out / "log.jsonl", "a")
    step = 0
    for ep in range(a.epochs):
        model.train()
        seen, loss_sum, t_ep = 0, 0.0, time.time()
        for xb, yb in loader:
            x = light_augment(to_input(xb)).to(dev, non_blocking=True)
            y = torch.as_tensor(yb, dtype=torch.long).to(dev)
            loss = crit(model(x), y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            step += 1
            seen += len(y)
            loss_sum += loss.item() * len(y)
            if step % 100 == 0:
                print(f"ep {ep} step {step}/{total} loss {loss_sum / seen:.3f} {seen / (time.time() - t_ep):.0f} img/s lr {sched.get_last_lr()[0]:.2e}", flush=True)
            if a.max_minutes and (time.time() - t0) / 60 > a.max_minutes:
                break
            if not a.pool and seen >= a.samples_per_epoch:
                break
        m = evaluate(model, Xv, Yv, dev)
        m.update(epoch=ep, loss=loss_sum / max(1, seen), minutes=(time.time() - t0) / 60)
        print("VAL", json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in m.items()}), flush=True)
        log.write(json.dumps(m) + "\n")
        log.flush()
        ckpt = {"model": model.state_dict(), "arch": a.arch, "size": a.size, "epoch": ep, "metrics": m}
        torch.save(ckpt, out / "last.pt")
        score = m["acc"]
        if score > best:
            best = score
            torch.save(ckpt, out / "best.pt")
        if a.max_minutes and (time.time() - t0) / 60 > a.max_minutes:
            print("tiempo maximo alcanzado")
            break
    print(f"listo en {(time.time() - t0) / 60:.1f} min; mejor acc {best:.4f}; checkpoints en {out}")


if __name__ == "__main__":
    main()
