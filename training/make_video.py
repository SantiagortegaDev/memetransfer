"""Video sintetico de una transmision vista por la camara de otro telefono.

A diferencia de synth.py (una muestra independiente por imagen), aca todo es
coherente en el tiempo: la pose tiembla suave (mano), la exposicion y los
reflejos son fijos, y en cada cambio de simbolo la camara integra la mezcla
de los dos estados durante su tiempo de exposicion.

Sirve para probar la cadena completa en el navegador (Playwright) sin
telefonos y para validar training/eval_video.py.

Salidas:
  --mjpeg out.mjpeg   camara falsa de Chrome (--use-file-for-fake-video-capture)
  --webm out.webm     archivo para el modo "Cargar video" (VP8, via ffmpeg)
  --truth out.json    linea de tiempo real (que se mostraba en cada instante)

Ejemplos:
  python training/make_video.py --text "hola mundo" --passes 2 --webm hola.webm --mjpeg hola.mjpeg
  python training/make_video.py --calibration --speed rapido --passes 1 --webm cal.webm --truth cal.json
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys

import cv2
import numpy as np

import common as C
from synth import Synth

SPEEDS = {"lento": (700, 200), "normal": (500, 150), "rapido": (320, 110)}  # = js/sender.js


# --- protocolo (misma trama que js/protocol.js) --------------------------------
def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def transmission(text: str) -> list[int]:
    import reedsolo  # pip install reedsolo (solo para generar videos de prueba)

    payload = text.encode("utf-8")
    c = crc16(payload)
    data = bytes([len(payload)]) + payload + bytes([c >> 8, c & 0xFF])
    nsym = max(4, math.ceil(len(data) / 3))
    cw = reedsolo.RSCodec(nsym, nsize=255).encode(data)
    return [C.START, *cw, C.END]


class VideoCamera:
    def __init__(self, seed: int, W: int, H: int, difficulty: float):
        self.s = Synth(seed=seed)
        self.r = np.random.default_rng(seed)
        self.W, self.H, self.d = W, H, difficulty
        r = self.r
        self.bg = self.s.background(W, H)
        self.screen_side = int(r.integers(220, 320))
        self.bezel = int(self.screen_side * r.uniform(0.03, 0.08))
        self.aspect = r.uniform(1.6, 2.1)
        # pose base (+ temblor)
        self.yaw0 = r.uniform(-20, 20) * difficulty
        self.pitch0 = r.uniform(-20, 20) * difficulty
        self.roll0 = r.uniform(-12, 12) * difficulty
        self.scale0 = r.uniform(0.55, 0.8)
        self.shake = 0.5 + 1.5 * difficulty
        self.phase = r.uniform(0, 100, 6)
        # fotometria fija
        self.expo = r.uniform(0.85, 1.25)
        self.gamma = r.uniform(0.85, 1.15)
        self.wb = (r.uniform(0.9, 1.1), 1.0, r.uniform(0.9, 1.1))
        self.glare = (r.uniform(0, W), r.uniform(0, H), r.uniform(0.3, 0.7) * max(W, H), r.uniform(0.05, 0.25) * difficulty)
        self.blur = r.uniform(0.6, 0.6 + 1.2 * difficulty)
        self.noise = 2 + 5 * difficulty
        self.moire = r.random() < 0.6
        self.images = self.s.images
        self._tex_cache = {}

    def texture(self, content_key):
        """Pantalla del emisor para un simbolo (o None = gap)."""
        if content_key in self._tex_cache:
            return self._tex_cache[content_key]
        side = self.screen_side
        sq = C.render_sender_square(None if content_key is None else self.images[content_key], side)
        short = side / C.OUTER_FRACTION
        sw, sh = int(short), int(short * self.aspect)
        b = self.bezel
        tex = np.full((sh + 2 * b, sw + 2 * b, 3), 18, np.uint8)
        screen = np.zeros((sh, sw, 3), np.uint8)
        x0, y0 = (sw - side) // 2, (sh - side) // 2
        screen[y0 : y0 + side, x0 : x0 + side] = sq
        tex[b : b + sh, b : b + sw] = screen
        corners = np.array([[b + x0, b + y0], [b + x0 + side, b + y0], [b + x0 + side, b + y0 + side], [b + x0, b + y0 + side]], np.float32)
        if len(self._tex_cache) > 64:
            self._tex_cache.clear()
        self._tex_cache[content_key] = (tex, corners)
        return tex, corners

    def pose(self, t):
        """Homografia textura -> camara en el instante t (s)."""
        p = self.phase
        k = self.shake
        yaw = math.radians(self.yaw0 + k * 2.0 * math.sin(0.7 * t + p[0]))
        pitch = math.radians(self.pitch0 + k * 2.0 * math.sin(0.9 * t + p[1]))
        roll = math.radians(self.roll0 + k * 1.5 * math.sin(0.5 * t + p[2]))
        dx = k * 0.012 * math.sin(1.3 * t + p[3]) + k * 0.004 * math.sin(7.0 * t + p[4])
        dy = k * 0.012 * math.sin(1.1 * t + p[5]) + k * 0.004 * math.sin(6.0 * t + p[0])
        tex, fc = self.texture(None)
        th, tw = tex.shape[:2]
        side = fc[1, 0] - fc[0, 0]
        cx, cy = fc.mean(0)
        W, H = self.W, self.H
        f = max(W, H) * 1.0
        target = min(W, H) * self.scale0
        z = f * side / target
        cy_, sy_ = math.cos(yaw), math.sin(yaw)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll), math.sin(roll)
        R = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]]) @ np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]]) @ np.array([[cy_, 0, sy_], [0, 1, 0], [-sy_, 0, cy_]])
        src = np.array([[0, 0], [tw, 0], [tw, th], [0, th]], np.float32)
        dst = []
        for u, v in src:
            P = R @ np.array([u - cx, v - cy, 0.0]) + np.array([dx * W * z / f, dy * H * z / f, z])
            dst.append([f * P[0] / P[2] + W / 2, f * P[1] / P[2] + H / 2])
        return cv2.getPerspectiveTransform(src, np.array(dst, np.float32))

    def render(self, t, states):
        """states: [(contenido, peso)] mezclados durante la exposicion."""
        W, H = self.W, self.H
        M = self.pose(t)
        acc = np.zeros((H, W, 3), np.float32)
        for key, w in states:
            tex, _ = self.texture(key)
            img = cv2.warpPerspective(tex, M, (W, H), dst=self.bg.copy(), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
            acc += w * img.astype(np.float32)
        img = acc / 255.0
        tex, _ = self.texture(None)
        mask = cv2.warpPerspective(np.ones(tex.shape[:2], np.float32), M, (W, H))[..., None]
        if self.moire:
            yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
            wave = np.sin(xx * 0.31 + yy * 0.17 + t * 2.0) * 0.5 + np.sin(xx * 0.05 - yy * 0.29) * 0.5
            img = img * (1 + 0.06 * self.d * wave[..., None] * mask)
        gx, gy, gr, gk = self.glare
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        img = img + gk * np.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * gr**2))[..., None]
        img = np.clip(img * self.expo * np.array(self.wb, np.float32), 0, 1) ** self.gamma
        img = (img * 255).astype(np.uint8)
        img = cv2.GaussianBlur(img, (0, 0), self.blur)
        noise = self.r.normal(0, self.noise, img.shape).astype(np.float32)
        return np.clip(img.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--text")
    g.add_argument("--calibration", action="store_true")
    ap.add_argument("--speed", choices=SPEEDS, default="normal")
    ap.add_argument("--passes", type=float, default=2.0, help="pasadas del loop (puede ser fraccionario)")
    ap.add_argument("--start-offset", type=float, default=0.0, help="fraccion de pasada en que arranca el video (enganche a mitad)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--size", default="640x480")
    ap.add_argument("--difficulty", type=float, default=0.5, help="0 = facil .. 1 = dificil")
    ap.add_argument("--exposure-ms", type=float, default=16.0)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--mjpeg")
    ap.add_argument("--webm")
    ap.add_argument("--truth")
    ap.add_argument("--ffmpeg", default="/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux")
    a = ap.parse_args()

    symbols = list(range(258)) if a.calibration else transmission(a.text)
    sym_ms, gap_ms = SPEEDS[a.speed]
    period = sym_ms + gap_ms
    total_ms = len(symbols) * period
    W, H = map(int, a.size.split("x"))
    cam = VideoCamera(a.seed, W, H, a.difficulty)
    t0 = a.start_offset * total_ms
    duration = a.passes * total_ms
    n_frames = int(duration / 1000 * a.fps)

    def state_at(ms):
        k = int(ms // period)
        inside = ms - k * period
        return (None if inside >= sym_ms else symbols[k % len(symbols)]), k

    # el ffmpeg de Playwright no lee de un pipe: primero el MJPEG a disco
    mjpeg_path = a.mjpeg or (a.webm + ".mjpeg" if a.webm else None)
    mj = open(mjpeg_path, "wb") if mjpeg_path else None
    truth = []
    for i in range(n_frames):
        ms = t0 + i * 1000 / a.fps
        # integra la exposicion en 4 sub-instantes
        subs = [state_at(ms + a.exposure_ms * (j + 0.5) / 4)[0] for j in range(4)]
        states = {}
        for s in subs:
            states[s] = states.get(s, 0) + 0.25
        img = cam.render(ms / 1000, list(states.items()))
        cur, k = state_at(ms + a.exposure_ms / 2)
        truth.append({"frame": i, "t": i * 1000 / a.fps, "symbol": cur, "index": k % len(symbols), "pass": k // len(symbols), "mixed": len(states) > 1})
        ok, enc = cv2.imencode(".jpg", img[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 90])
        if mj:
            mj.write(enc.tobytes())
        if i % 100 == 0:
            print(f"  frame {i}/{n_frames}", file=sys.stderr, flush=True)
    if mj:
        mj.close()
    if a.webm:
        subprocess.run(
            [a.ffmpeg, "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(a.fps), "-c:v", "mjpeg", "-i", mjpeg_path, "-c:v", "vp8", "-b:v", "4M", "-deadline", "good", "-cpu-used", "4", a.webm],
            check=True,
        )
        if not a.mjpeg:
            import os

            os.unlink(mjpeg_path)
    if a.truth:
        with open(a.truth, "w") as f:
            json.dump({"symbols": symbols, "symbol_ms": sym_ms, "gap_ms": gap_ms, "fps": a.fps, "text": a.text, "frames": truth}, f)
    print(f"{n_frames} frames, {duration / 1000:.1f} s, {len(symbols)} simbolos por pasada")


if __name__ == "__main__":
    main()
