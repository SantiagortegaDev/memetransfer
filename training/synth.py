"""Generador de dataset sintetico: "fotos" de la pantalla del emisor tomadas
con la camara de otro telefono, ya pasadas por el localizador.

Cada muestra:
  1. Contenido del emisor: meme (o START/END) estirado dentro del marco
     magenta, igual que js/sender.js. Para NONE: gap gris, pantalla negra,
     mezclas alfa entre dos memes o meme+gris (transiciones), o nada.
  2. Pantalla: el cuadrado centrado en una pantalla negra con bisel, con
     rejilla de subpixeles RGB opcional (genera moire real al remuestrear).
  3. Pose 3D aleatoria (+-35 grados de inclinacion, rotacion en el plano,
     escala, recorte parcial en el borde de la imagen) y composicion sobre un
     fondo procedural o con memes distractores.
  4. Camara: gamma/exposicion/balance de blancos, reflejo radial, vineteo,
     bandas de refresco, interferencia sinusoidal (moire), desenfoque de foco y
     de movimiento, ruido, JPEG y perdida de color.
  5. Localizador REAL (training/common.py, identico a js/locator.js) sobre la
     imagen sintetica + jitter de esquinas; si no encuentra el marco, recorte
     central (el modelo aprende a degradar suave).
  6. Rotacion aleatoria de 90 grados: el marco no tiene orientacion, y el
     receptor puede tener el telefono en horizontal.

Uso:
  python training/synth.py --grid grid.jpg          # grilla para revisar a ojo
  python training/synth.py --bench                  # muestras por segundo
"""

from __future__ import annotations

import argparse
import math
import time

import cv2
import numpy as np

import common as C

CAM_SIZES = [(640, 480), (640, 360), (480, 640), (360, 640), (800, 450)]


class Synth:
    def __init__(self, size: int = 160, p_none: float = 0.12, seed: int = 0, images=None, focus=None, p_focus: float = 0.3):
        self.size = size
        self.p_none = p_none
        # clases a sobremuestrear (p. ej. memes recien reemplazados)
        self.focus = list(focus or [])
        self.p_focus = p_focus
        self.images = images if images is not None else C.load_class_images()
        # texturas de contenido cacheadas a 2 resoluciones (interior del marco)
        self.small = [cv2.resize(im, (192, 192), interpolation=cv2.INTER_AREA) for im in self.images]
        self.rng = np.random.default_rng(seed)

    # ------------------------------------------------------------------ utils
    def u(self, a, b):
        return float(self.rng.uniform(a, b))

    def chance(self, p):
        return self.rng.random() < p

    # ---------------------------------------------------------------- content
    def content(self, label: int):
        """Devuelve (contenido RGB o None para gris, label final)."""
        r = self.rng
        if label != C.NONE:
            img = self.images[label]
            if self.chance(0.08):  # transicion todavia reconocible
                a = self.u(0.7, 0.95)
                gray = np.full_like(img, C.GAP_GRAY)
                img = cv2.addWeighted(img, a, gray, 1 - a, 0)
            return img, label
        # (sin "pantalla blanca": se confundia con START, que es casi blanco)
        kind = r.choice(["gap", "blend2", "blendgray", "black", "noscreen"], p=[0.33, 0.25, 0.16, 0.08, 0.18])
        if kind == "gap":
            return None, C.NONE
        if kind == "black":
            return np.zeros((64, 64, 3), np.uint8), C.NONE
        if kind == "noscreen":
            return "noscreen", C.NONE
        i, j = r.choice(len(self.small), 2, replace=False)
        a = self.u(0.3, 0.7)
        if kind == "blend2":
            return cv2.addWeighted(self.small[i], a, self.small[j], 1 - a, 0), C.NONE
        a = self.u(0.1, 0.45)
        gray = np.full_like(self.small[i], C.GAP_GRAY)
        return cv2.addWeighted(self.small[i], a, gray, 1 - a, 0), C.NONE

    # ------------------------------------------------------------- background
    def background(self, W, H):
        r = self.rng
        kind = r.choice(["gradient", "shapes", "meme", "noise"], p=[0.3, 0.3, 0.25, 0.15])
        if kind == "meme":
            im = self.images[int(r.integers(len(self.images)))]
            bg = cv2.resize(im, (W, H), interpolation=cv2.INTER_LINEAR)
            bg = cv2.GaussianBlur(bg, (0, 0), self.u(0.5, 6))
            return cv2.convertScaleAbs(bg, alpha=self.u(0.3, 1.1))
        corners = r.integers(0, 256, (2, 2, 3)).astype(np.uint8)
        bg = cv2.resize(corners, (W, H), interpolation=cv2.INTER_LINEAR)
        if kind == "shapes":
            for _ in range(int(r.integers(3, 15))):
                col = tuple(int(v) for v in r.integers(0, 256, 3))
                if self.chance(0.5):
                    p1 = (int(r.integers(-50, W)), int(r.integers(-50, H)))
                    p2 = (p1[0] + int(r.integers(10, W // 2)), p1[1] + int(r.integers(10, H // 2)))
                    cv2.rectangle(bg, p1, p2, col, -1)
                else:
                    cv2.circle(bg, (int(r.integers(0, W)), int(r.integers(0, H))), int(r.integers(5, W // 3)), col, -1)
            bg = cv2.GaussianBlur(bg, (0, 0), self.u(0.5, 4))
        elif kind == "noise":
            small = r.integers(0, 256, (H // 16 + 1, W // 16 + 1, 3)).astype(np.uint8)
            bg = cv2.addWeighted(bg, 0.5, cv2.resize(small, (W, H), interpolation=cv2.INTER_CUBIC), 0.5, 0)
        return bg

    # ----------------------------------------------------------------- screen
    def screen_texture(self, content):
        """Pantalla del emisor (negro + cuadrado con marco) con bisel.
        Devuelve (textura, esquinas exteriores del marco en la textura)."""
        r = self.rng
        side = int(r.integers(180, 420))
        square = C.render_sender_square(None if content is None else content, side)
        # la pantalla: el cuadrado ocupa OUTER_FRACTION del lado corto
        short = side / C.OUTER_FRACTION
        aspect = self.u(1.3, 2.2)
        if self.chance(0.5):
            sw, sh = short, short * aspect
        else:
            sw, sh = short * aspect, short
        sw, sh = int(sw), int(sh)
        bez = int(short * self.u(0.02, 0.12))
        bez_col = r.choice([0, 15, 30, 200, 235]) + r.integers(-10, 10, 3)
        tex = np.empty((sh + 2 * bez, sw + 2 * bez, 3), np.uint8)
        tex[:] = np.clip(bez_col, 0, 255)
        screen = np.zeros((sh, sw, 3), np.uint8)
        screen[:] = int(r.integers(0, 12))  # negro del emisor (+ fuga de luz del panel)
        x0, y0 = (sw - side) // 2, (sh - side) // 2
        screen[y0 : y0 + side, x0 : x0 + side] = square
        # rejilla de subpixeles: cada pixel -> 3 columnas R,G,B (+ fila oscura)
        if self.chance(0.45) and side < 330:
            f = 3
            screen = cv2.resize(screen, (sw * f, sh * f), interpolation=cv2.INTER_NEAREST)
            x0, y0, side, bez = x0 * f, y0 * f, side * f, bez * f
            mask = np.zeros((f, f, 3), np.float32)
            for k in range(3):
                mask[:, k, k] = 1.0
            mask[f - 1, :, :] *= self.u(0.3, 0.8)
            mask *= 3.0 * self.u(0.8, 1.0)
            tile = np.tile(mask, (side // f, side // f, 1))
            sq = screen[y0 : y0 + side, x0 : x0 + side]
            screen[y0 : y0 + side, x0 : x0 + side] = cv2.multiply(sq, tile, dtype=cv2.CV_8U)
            tex = cv2.resize(tex, (screen.shape[1] + 2 * bez, screen.shape[0] + 2 * bez), interpolation=cv2.INTER_NEAREST)
        # brillo y gamma del panel emisor
        x = np.arange(256, dtype=np.float32) / 255.0
        lut = (np.clip(x * self.u(0.55, 1.35), 0, 1) ** self.u(0.8, 1.25) * 255).astype(np.uint8)
        screen = cv2.LUT(screen, lut)
        tex[bez : bez + screen.shape[0], bez : bez + screen.shape[1]] = screen
        ox, oy = bez + x0, bez + y0
        corners = np.array([[ox, oy], [ox + side, oy], [ox + side, oy + side], [ox, oy + side]], np.float32)
        return tex, corners

    # ------------------------------------------------------------------- pose
    def pose(self, tex_shape, frame_corners, W, H):
        """Homografia textura -> camara con una rotacion 3D aleatoria."""
        r = self.rng
        th, tw = tex_shape[:2]
        side = frame_corners[1, 0] - frame_corners[0, 0]
        cx, cy = frame_corners.mean(0)
        yaw = math.radians(self.u(-35, 35))
        pitch = math.radians(self.u(-35, 35))
        roll = math.radians(self.u(-25, 25) if self.chance(0.9) else self.u(-60, 60))
        cy_, sy_ = math.cos(yaw), math.sin(yaw)
        cp, sp = math.cos(pitch), math.sin(pitch)
        cr, sr = math.cos(roll), math.sin(roll)
        Ry = np.array([[cy_, 0, sy_], [0, 1, 0], [-sy_, 0, cy_]])
        Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
        Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
        R = Rz @ Rx @ Ry
        f = max(W, H) * self.u(0.75, 1.3)
        # tamano aparente del marco: fraccion del lado corto de la camara
        target = min(W, H) * self.u(0.3, 0.92)
        z = f * side / target
        # desplazamiento del centro del marco (permite que se salga un poco)
        tx = self.u(-0.15, 0.15) * W * z / f
        ty = self.u(-0.15, 0.15) * H * z / f
        src = np.array([[0, 0], [tw, 0], [tw, th], [0, th]], np.float32)
        dst = []
        for u, v in src:
            X = np.array([u - cx, v - cy, 0.0])
            P = R @ X + np.array([tx, ty, z])
            dst.append([f * P[0] / P[2] + W / 2, f * P[1] / P[2] + H / 2])
        dst = np.array(dst, np.float32)
        return cv2.getPerspectiveTransform(src, dst)

    # ----------------------------------------------------------------- camera
    def _wave_bank(self):
        """Banco de patrones de interferencia (moire) precalculados, int8."""
        if not hasattr(self, "_waves"):
            r = np.random.default_rng(12345)
            N = 800
            yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
            bank = []
            for _ in range(24):
                ang, fr = r.uniform(0, math.pi), r.uniform(0.15, 0.9)
                w = np.sin((xx * math.cos(ang) + yy * math.sin(ang)) * fr + r.uniform(0, 6.28))
                if r.random() < 0.5:
                    ang2, fr2 = r.uniform(0, math.pi), r.uniform(0.15, 0.9)
                    w = 0.5 * w + 0.5 * np.sin((xx * math.cos(ang2) + yy * math.sin(ang2)) * fr2)
                bank.append((w * 127).astype(np.int8))
            self._waves = bank
        return self._waves

    def _smooth_field(self, W, H, fn):
        """Campo suave calculado en baja resolucion y ampliado (reflejos, vineteo)."""
        w, h = max(2, W // 8), max(2, H // 8)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        return cv2.resize(fn(xx * 8, yy * 8), (W, H), interpolation=cv2.INTER_LINEAR)

    def camera_effects(self, img, screen_mask):
        r = self.rng
        H, W = img.shape[:2]
        m = screen_mask.astype(bool)
        # interferencia sinusoidal (moire) y bandas de refresco, solo en la pantalla
        if self.chance(0.35):
            bank = self._wave_bank()
            wv = bank[int(r.integers(len(bank)))]
            y0, x0 = int(r.integers(0, 800 - H + 1)), int(r.integers(0, 800 - W + 1))
            wave = wv[y0 : y0 + H, x0 : x0 + W].astype(np.float32) / 127.0
            gain = 1 + self.u(0.03, 0.15) * wave
            if self.chance(0.3):
                yy = np.arange(H, dtype=np.float32)[:, None]
                gain = gain * (1 - self.u(0.05, 0.25) * (0.5 + 0.5 * np.sin(yy * self.u(0.02, 0.12) + self.u(0, 6.28))))
            gain = np.where(m, gain, 1.0).astype(np.float32)
            img = cv2.multiply(img, cv2.merge([gain, gain, gain]), dtype=cv2.CV_8U)
        # reflejo radial
        if self.chance(0.4):
            gx, gy = self.u(0, W), self.u(0, H)
            rad = self.u(0.15, 0.8) * max(W, H)
            k = self.u(0.05, 0.5) * 255
            glare = self._smooth_field(W, H, lambda x, y: k * np.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (2 * rad**2)))
            g8 = np.clip(glare, 0, 255).astype(np.uint8)
            img = cv2.add(img, cv2.merge([g8, g8, g8]))
        # brillo del panel + exposicion + balance de blancos + gamma: una LUT por canal
        expo = self.u(0.6, 1.6)
        gamma = self.u(0.75, 1.3)
        wb = (self.u(0.8, 1.2), 1.0, self.u(0.8, 1.2))
        x = np.arange(256, dtype=np.float32) / 255.0
        chans = list(cv2.split(img))
        for c in range(3):
            lut = (np.clip(x * expo * wb[c], 0, 1) ** gamma * 255).astype(np.uint8)
            chans[c] = cv2.LUT(chans[c], lut)
        img = cv2.merge(chans)
        # vineteo
        if self.chance(0.4):
            k = self.u(0.1, 0.5)
            vig = self._smooth_field(W, H, lambda x, y: 1 - k * (((x - W / 2) ** 2 + (y - H / 2) ** 2) / ((W / 2) ** 2 + (H / 2) ** 2)))
            img = cv2.multiply(img, cv2.merge([vig, vig, vig]), dtype=cv2.CV_8U)
        # desenfoque: optico base (siempre, como el filtro de la camara) + foco + movimiento
        img = cv2.GaussianBlur(img, (0, 0), self.u(0.5, 1.0))
        if self.chance(0.4):
            img = cv2.GaussianBlur(img, (0, 0), self.u(0.5, 2.2))
        if self.chance(0.3):
            L = int(r.integers(3, 12))
            ker = np.zeros((L, L), np.float32)
            ker[L // 2, :] = 1.0 / L
            M = cv2.getRotationMatrix2D((L / 2 - 0.5, L / 2 - 0.5), self.u(0, 180), 1.0)
            ker = cv2.warpAffine(ker, M, (L, L))
            ker /= max(ker.sum(), 1e-6)
            img = cv2.filter2D(img, -1, ker)
        # ruido
        if self.chance(0.7):
            noise = np.empty(img.shape, np.int16)
            cv2.randn(noise, 0, self.u(1, 9))
            img = cv2.add(img.astype(np.int16), noise, dtype=cv2.CV_8U)
        # perdida de color
        if self.chance(0.2):
            g = cv2.cvtColor(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), cv2.COLOR_GRAY2RGB)
            a = self.u(0.2, 0.6)
            img = cv2.addWeighted(img, 1 - a, g, a, 0)
        # JPEG
        if self.chance(0.7):
            ok, enc = cv2.imencode(".jpg", img[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, int(r.integers(35, 95))])
            img = cv2.imdecode(enc, cv2.IMREAD_COLOR)[..., ::-1]
        return np.ascontiguousarray(img)

    # ----------------------------------------------------------------- sample
    def camera_image(self, label: int):
        """Imagen de camara completa + esquinas reales del marco (o None) + label."""
        W, H = CAM_SIZES[int(self.rng.integers(len(CAM_SIZES)))]
        content, label = self.content(label)
        bg = self.background(W, H)
        if isinstance(content, str):  # noscreen
            img = self.camera_effects(bg, np.zeros((H, W), np.uint8))
            return img, None, label
        tex, fc = self.screen_texture(content)
        M = self.pose(tex.shape, fc, W, H)
        img = cv2.warpPerspective(tex, M, (W, H), dst=bg.copy(), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
        mask = cv2.warpPerspective(np.ones(tex.shape[:2], np.uint8), M, (W, H), flags=cv2.INTER_NEAREST)
        # oclusion parcial (dedo/mano)
        if self.chance(0.08):
            col = (int(self.rng.integers(120, 230)), int(self.rng.integers(80, 180)), int(self.rng.integers(60, 150)))
            c = (int(self.rng.integers(0, W)), H + int(self.rng.integers(0, H // 4)))
            cv2.ellipse(img, c, (int(W * self.u(0.05, 0.15)), int(H * self.u(0.2, 0.5))), self.u(-40, 40), 0, 360, col, -1)
        img = self.camera_effects(img, mask)
        corners = cv2.perspectiveTransform(fc[None], M)[0]
        return img, corners, label

    def sample(self, label: int | None = None):
        """Devuelve (recorte size x size RGB, label)."""
        if label is None and self.focus and self.chance(self.p_focus):
            label = int(self.focus[int(self.rng.integers(len(self.focus)))])
        if label is None:
            u = self.rng.random()
            # START/END sobremuestreados: son las anclas de la trama
            if u < self.p_none:
                label = C.NONE
            elif u < self.p_none + 0.05:
                label = C.START
            elif u < self.p_none + 0.08:
                label = C.END
            else:
                label = int(self.rng.integers(256))
        for _ in range(4):
            img, true_corners, lab = self.camera_image(label)
            q = C.locate_frame(img)
            if q is not None and true_corners is not None:
                err = np.abs(q - true_corners).max() / max(1.0, np.hypot(*(true_corners[2] - true_corners[0])))
                if err > 0.2:
                    lab = C.NONE  # el localizador encontro otra cosa: el recorte es basura
            if q is not None:
                side = np.hypot(*(q[1] - q[0]))
                jit = 0.01 if self.chance(0.8) else 0.03
                q = q + self.rng.normal(0, jit * side, q.shape)
                crop = C.crop_interior(img, q, self.size)
            else:
                if lab != C.NONE and self.chance(0.6):
                    continue  # re-sortea: pocas muestras de recorte central etiquetadas
                crop = C.center_crop(img, self.size)
                if lab != C.NONE and true_corners is not None:
                    # solo se etiqueta como meme si el interior cubre bien el recorte central
                    H, W = img.shape[:2]
                    s = min(H, W) * C.CENTER_CROP_FRACTION
                    box = np.array([[(W - s) / 2, (H - s) / 2], [(W + s) / 2, (H - s) / 2], [(W + s) / 2, (H + s) / 2], [(W - s) / 2, (H + s) / 2]], np.float32)
                    inner = C.interior_corners(true_corners).astype(np.float32)
                    inter, _ = cv2.intersectConvexConvex(box, inner)
                    if inter < 0.5 * s * s:
                        lab = C.NONE
            crop = np.ascontiguousarray(np.rot90(crop, int(self.rng.integers(4))))
            return crop, lab
        crop = np.ascontiguousarray(np.rot90(C.center_crop(img, self.size), int(self.rng.integers(4))))
        return crop, C.NONE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", help="guarda una grilla de muestras en este archivo")
    ap.add_argument("--camera-grid", help="grilla de imagenes de camara completas (antes del localizador)")
    ap.add_argument("--rows", type=int, default=8)
    ap.add_argument("--cols", type=int, default=12)
    ap.add_argument("--size", type=int, default=160)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--bench", action="store_true")
    a = ap.parse_args()
    s = Synth(size=a.size, seed=a.seed)
    labels = C.class_labels()
    if a.bench:
        t = time.time()
        n = 200
        for _ in range(n):
            s.sample()
        print(f"{n / (time.time() - t):.1f} muestras/s (1 proceso)")
    if a.grid:
        tiles = []
        for _ in range(a.rows * a.cols):
            crop, lab = s.sample()
            tile = cv2.copyMakeBorder(crop, 0, 18, 0, 0, cv2.BORDER_CONSTANT, value=(0, 0, 0))
            cv2.putText(tile, labels[lab], (3, a.size + 13), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
            tiles.append(tile)
        rows = [np.hstack(tiles[i * a.cols : (i + 1) * a.cols]) for i in range(a.rows)]
        cv2.imwrite(a.grid, np.vstack(rows)[..., ::-1])
        print("grilla ->", a.grid)
    if a.camera_grid:
        tiles = []
        for _ in range(12):
            img, corners, lab = s.camera_image(None if False else int(s.rng.integers(258)))
            q = C.locate_frame(img)
            vis = img.copy()
            if q is not None:
                cv2.polylines(vis, [q.astype(np.int32)], True, (0, 255, 0), 2)
            tiles.append(cv2.resize(vis, (320, 240)))
        rows = [np.hstack(tiles[i * 4 : (i + 1) * 4]) for i in range(3)]
        cv2.imwrite(a.camera_grid, np.vstack(rows)[..., ::-1])
        print("grilla de camara ->", a.camera_grid)


if __name__ == "__main__":
    main()
