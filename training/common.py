"""Constantes y algoritmos compartidos con la web.

IMPORTANTE: el layout del emisor, el localizador y la metrica de gap tienen
que coincidir con js/layout.js y js/locator.js. test/layout-sync.test.js
verifica que las constantes numericas sean iguales en ambos lados.
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MEMES_DIR = ROOT / "memes"

# --- Layout del emisor (js/layout.js) ---------------------------------------
FRAME_RGB = (255, 0, 170)  # magenta #FF00AA
BORDER = 0.06  # grosor del marco, fraccion del lado exterior
OUTER_FRACTION = 0.92  # lado exterior del marco / min(ancho, alto) de la pantalla
GAP_GRAY = 128  # gris del gap entre memes

# --- Clases ------------------------------------------------------------------
START = 256
END = 257
NONE = 258
NUM_CLASSES = 259

# --- Localizador (js/locator.js) ---------------------------------------------
LOCATE_WIDTH = 320  # el frame se reduce a este ancho para buscar el marco
HUE_MIN = 280.0  # rango de tono del magenta (grados)
HUE_MAX = 352.0
SAT_MIN = 0.35
CHROMA_MIN = 40
MIN_AREA_FRACTION = 0.002
RING_FILL_MIN = 0.1  # pixeles del componente / area del cuadrilatero (anillo ideal: 0.2256)
RING_FILL_MAX = 0.45
MAX_CANDIDATES = 3
CENTER_CROP_FRACTION = 0.8  # recorte de respaldo si no se encuentra el marco

# --- Gap (js/locator.js) -------------------------------------------------------
GAP_GRID = 16
GAP_RESIDUAL_MAX = 2.0  # gap seguro, sin preguntar al modelo
GAP_RESIDUAL_NONE_MAX = 10.0  # gap si ademas el modelo dice NONE


def class_files() -> list[str]:
    """Archivo de imagen de cada clase 0..257 (NONE no tiene imagen)."""
    manifest = json.loads((MEMES_DIR / "manifest.json").read_text())
    assert len(manifest) == 256
    return manifest + ["control-start.jpg", "control-end.jpg"]


def class_labels() -> list[str]:
    return [str(i) for i in range(256)] + ["START", "END", "NONE"]


def load_class_images() -> list[np.ndarray]:
    """Imagenes RGB uint8 de las 258 clases con imagen."""
    out = []
    for f in class_files():
        bgr = cv2.imread(str(MEMES_DIR / f), cv2.IMREAD_COLOR)
        if bgr is None:
            raise FileNotFoundError(f)
        out.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    return out


def render_sender_square(content: np.ndarray | None, side: int) -> np.ndarray:
    """Cuadrado exterior del emisor: marco magenta + contenido estirado adentro.

    content=None dibuja el gap (interior gris uniforme).
    """
    img = np.empty((side, side, 3), np.uint8)
    img[:] = FRAME_RGB
    b = round(side * BORDER)
    inner = side - 2 * b
    if content is None:
        img[b : b + inner, b : b + inner] = GAP_GRAY
    else:
        img[b : b + inner, b : b + inner] = cv2.resize(content, (inner, inner), interpolation=cv2.INTER_AREA if content.shape[0] > inner else cv2.INTER_LINEAR)
    return img


# ------------------------------------------------------------------------------
# Localizador
# ------------------------------------------------------------------------------


def magenta_mask(rgb: np.ndarray) -> np.ndarray:
    """Pixeles del marco: tono magenta, saturados. Misma regla que js/locator.js."""
    r, g, b = cv2.split(rgb)
    mx = cv2.max(cv2.max(r, g), b).astype(np.int32)
    mn = cv2.min(cv2.min(r, g), b).astype(np.int32)
    chroma = mx - mn
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV_FULL)  # H en 0..255 = 0..360 grados
    h = hsv[..., 0].astype(np.float32) * (360.0 / 256.0)
    return (chroma >= CHROMA_MIN) & (chroma >= SAT_MIN * mx) & (h >= HUE_MIN) & (h <= HUE_MAX)


def _row_extremes(labels: np.ndarray, lab: int) -> np.ndarray:
    """Extremos izquierdo/derecho de cada fila del componente, en bordes de
    pixel (el pixel (x, y) cubre [x, x+1) x [y, y+1))."""
    m = labels == lab
    rows = np.nonzero(m.any(1))[0]
    sub = m[rows]
    x0 = sub.argmax(1)
    x1 = m.shape[1] - sub[:, ::-1].argmax(1)
    y0 = rows
    y1 = rows + 1
    pts = np.concatenate([np.stack([x0, y0], 1), np.stack([x0, y1], 1), np.stack([x1, y0], 1), np.stack([x1, y1], 1)])
    return pts.astype(np.float64)


def _hull(points: np.ndarray) -> np.ndarray:
    """Envolvente convexa (monotone chain), sentido antihorario en coordenadas de imagen."""
    pts = sorted(set(map(tuple, points.tolist())))
    if len(pts) < 3:
        return np.array(pts, np.float64)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1], np.float64)


def _quad_from_hull(hull: np.ndarray) -> np.ndarray | None:
    n = len(hull)
    if n < 4:
        return None
    d = ((hull[:, None, :] - hull[None, :, :]) ** 2).sum(-1)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    a, c = hull[i], hull[j]
    ac = c - a
    side = ac[0] * (hull[:, 1] - a[1]) - ac[1] * (hull[:, 0] - a[0])
    k1, k2 = int(np.argmax(side)), int(np.argmin(side))
    if side[k1] <= 0 or side[k2] >= 0:
        return None
    return np.array([a, hull[k1], c, hull[k2]], np.float64)


def _order_corners(q: np.ndarray) -> np.ndarray:
    """Ordena en sentido horario (en pantalla) empezando por el de menor x+y."""
    c = q.mean(0)
    ang = np.arctan2(q[:, 1] - c[1], q[:, 0] - c[0])
    q = q[np.argsort(ang)]
    start = int(np.argmin(q[:, 0] + q[:, 1]))
    return np.roll(q, -start, axis=0)


def _refine(quad: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Ajusta una recta a los puntos de borde de cada lado y las intersecta."""
    lines = []
    for k in range(4):
        p, q = quad[k], quad[(k + 1) % 4]
        d = q - p
        L = np.hypot(*d)
        if L < 4:
            return quad
        u = d / L
        nrm = np.array([-u[1], u[0]])
        rel = pts - p
        t = rel @ u
        dist = np.abs(rel @ nrm)
        sel = pts[(dist < max(2.0, 0.03 * L)) & (t > 0.15 * L) & (t < 0.85 * L)]
        if len(sel) < 4:
            return quad
        m = sel.mean(0)
        cov = np.cov((sel - m).T)
        w, v = np.linalg.eigh(cov)
        direction = v[:, 1]
        lines.append((m, direction))
    out = []
    for k in range(4):
        (p1, d1), (p2, d2) = lines[k - 1], lines[k]
        A = np.array([d1, -d2]).T
        if abs(np.linalg.det(A)) < 1e-6:
            return quad
        t = np.linalg.solve(A, p2 - p1)
        out.append(p1 + t[0] * d1)
    out = np.array(out)
    if np.abs(out - quad).max() > 0.1 * np.hypot(*(quad[2] - quad[0])):
        return quad
    return out


def _quad_area(q: np.ndarray) -> float:
    x, y = q[:, 0], q[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def locate_frame_detailed(rgb: np.ndarray) -> tuple[np.ndarray | None, str]:
    """Busca el marco magenta. Devuelve (esquinas, estado):
    esquinas exteriores en pixeles de `rgb` (orden horario desde arriba-izquierda)
    o None; estado 'ok' | 'cut' (el marco toca el borde de la imagen) | 'none'."""
    H, W = rgb.shape[:2]
    scale = W / LOCATE_WIDTH
    h = max(1, round(H / scale))
    small = cv2.resize(rgb, (LOCATE_WIDTH, h), interpolation=cv2.INTER_AREA)
    mask = magenta_mask(small).astype(np.uint8)
    # la dilatacion reconecta los pedazos de un anillo cortado por moire o
    # reflejos; los puntos del contorno salen de la mascara original
    grown = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(grown, connectivity=8)
    if n <= 1:
        return None, "none"
    order = 1 + np.argsort(-stats[1:, cv2.CC_STAT_AREA])[:MAX_CANDIDATES]
    status = "none"
    for lab in order:
        if stats[lab, cv2.CC_STAT_AREA] < MIN_AREA_FRACTION * LOCATE_WIDTH * h:
            break
        x, y, w, hh = stats[lab, :4]
        if x <= 0 or y <= 0 or x + w >= LOCATE_WIDTH or y + hh >= h:
            status = "cut"
            continue
        comp = (labels == lab) & (mask > 0)
        area = int(comp.sum())
        if area < 8:
            continue
        pts = _row_extremes(comp.astype(np.int32), 1)
        quad = _quad_from_hull(_hull(pts))
        if quad is None:
            continue
        quad = _order_corners(quad)
        qa = _quad_area(quad)
        if qa <= 0 or not (RING_FILL_MIN <= area / qa <= RING_FILL_MAX):
            continue
        sides = [np.hypot(*(quad[(k + 1) % 4] - quad[k])) for k in range(4)]
        if min(sides) < 12 or max(sides) / min(sides) > 3.0:
            continue
        return _refine(quad, pts) * scale, "ok"
    return None, status


def locate_frame(rgb: np.ndarray) -> np.ndarray | None:
    return locate_frame_detailed(rgb)[0]


def interior_corners(outer: np.ndarray) -> np.ndarray:
    """Esquinas del interior del marco a partir de las exteriores (via homografia)."""
    unit = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32)
    Hm = cv2.getPerspectiveTransform(unit, outer.astype(np.float32))
    b = BORDER
    inner = np.array([[b, b], [1 - b, b], [1 - b, 1 - b], [b, 1 - b]], np.float32)
    return cv2.perspectiveTransform(inner[None], Hm)[0]


def crop_interior(rgb: np.ndarray, outer: np.ndarray, size: int) -> np.ndarray:
    src = interior_corners(outer).astype(np.float32)
    dst = np.array([[0, 0], [size, 0], [size, size], [0, size]], np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(rgb, M, (size, size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def center_crop(rgb: np.ndarray, size: int) -> np.ndarray:
    H, W = rgb.shape[:2]
    s = int(min(H, W) * CENTER_CROP_FRACTION)
    y0, x0 = (H - s) // 2, (W - s) // 2
    return cv2.resize(rgb[y0 : y0 + s, x0 : x0 + s], (size, size), interpolation=cv2.INTER_AREA)


def gap_residual(crop_rgb: np.ndarray) -> float:
    """Textura del recorte: desvio del residuo tras quitar un plano a la
    luminancia promediada en una grilla de 16x16. Un gap gris da ~0 aunque
    haya reflejos suaves o vineteo; un meme da mucho mas."""
    f = crop_rgb.astype(np.float32)
    y = 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]
    g = cv2.resize(y, (GAP_GRID, GAP_GRID), interpolation=cv2.INTER_AREA).astype(np.float64)
    c = (np.arange(GAP_GRID) - (GAP_GRID - 1) / 2).astype(np.float64)
    xs, ys = np.meshgrid(c, c)
    denom = (c**2).sum() * GAP_GRID
    bx = (g * xs).sum() / denom
    by = (g * ys).sum() / denom
    res = g - g.mean() - bx * xs - by * ys
    return float(np.sqrt((res**2).mean()))


def is_gap(crop_rgb: np.ndarray) -> bool:
    return gap_residual(crop_rgb) < GAP_RESIDUAL_MAX


def locate_and_crop(rgb: np.ndarray, size: int) -> tuple[np.ndarray, np.ndarray | None]:
    q = locate_frame(rgb)
    if q is None:
        return center_crop(rgb, size), None
    return crop_interior(rgb, q, size), q
