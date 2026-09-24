// Localizador del marco magenta. Mismo algoritmo que training/common.py
// (el modelo se entrena con recortes hechos por la version Python):
//
//  1. mascara de pixeles magenta (tono 280-352 grados, saturados) sobre el
//     frame reducido a LOCATE_WIDTH px de ancho
//  2. dilatacion 3x3 (reconecta un anillo cortado) + componentes conexos
//  3. de los MAX_CANDIDATES componentes mas grandes, el primero que:
//     no toque el borde de la imagen, y cuyo cuadrilatero tenga forma de
//     anillo (pixeles / area entre RING_FILL_MIN y RING_FILL_MAX)
//  4. cuadrilatero = diametro de la envolvente convexa + los dos puntos mas
//     lejanos a cada lado; se refina ajustando una recta a cada lado
//  5. homografia -> recorte size x size del interior del marco
//
// Si no hay marco, el receptor usa un recorte central (centerCrop).
//
// Todas las imagenes son objetos {data: Uint8ClampedArray RGBA, width, height}.

import { computeHomography, applyHomography } from "./homography.js";
import {
  BORDER,
  HUE_MIN,
  HUE_MAX,
  SAT_MIN,
  CHROMA_MIN,
  MIN_AREA_FRACTION,
  RING_FILL_MIN,
  RING_FILL_MAX,
  MAX_CANDIDATES,
  CENTER_CROP_FRACTION,
  GAP_GRID,
} from "./layout.js";

/** Mascara (1 = magenta) de una imagen RGBA. */
export function magentaMask(img) {
  const { data, width, height } = img;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const chroma = mx - mn;
    if (chroma < CHROMA_MIN || chroma < SAT_MIN * mx) continue;
    let h;
    if (mx === r) h = ((((g - b) / chroma) % 6) + 6) % 6;
    else if (mx === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    h *= 60;
    if (h >= HUE_MIN && h <= HUE_MAX) mask[p] = 1;
  }
  return mask;
}

function dilate3x3(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** Componentes conexos (8-vecinos). Devuelve labels (0 = fondo) y stats por label. */
function components(mask, w, h) {
  const labels = new Int32Array(mask.length);
  const stats = [null];
  const stack = new Int32Array(mask.length);
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const lab = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = lab;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !labels[q]) {
            labels[q] = lab;
            stack[sp++] = q;
          }
        }
      }
    }
    stats.push({ lab, area, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return { labels, stats };
}

/** Extremos izquierdo/derecho por fila, en bordes de pixel. */
function rowExtremes(labels, mask, lab, w, h, box) {
  const pts = [];
  let area = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    let x0 = -1;
    let x1 = -1;
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = y * w + x;
      if (labels[p] === lab && mask[p]) {
        area++;
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    if (x0 >= 0) pts.push([x0, y], [x0, y + 1], [x1 + 1, y], [x1 + 1, y + 1]);
  }
  return { pts, area };
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Envolvente convexa (monotone chain). */
export function convexHull(points) {
  const seen = new Set();
  const pts = [];
  for (const p of points) {
    const k = p[0] * 100003 + p[1];
    if (!seen.has(k)) {
      seen.add(k);
      pts.push(p);
    }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function quadFromHull(hull) {
  const n = hull.length;
  if (n < 4) return null;
  let best = -1;
  let ia = 0;
  let ic = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = hull[i][0] - hull[j][0];
      const dy = hull[i][1] - hull[j][1];
      const d = dx * dx + dy * dy;
      if (d > best) {
        best = d;
        ia = i;
        ic = j;
      }
    }
  }
  const a = hull[ia];
  const c = hull[ic];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  let kMax = -1;
  let kMin = -1;
  let sMax = -Infinity;
  let sMin = Infinity;
  for (let k = 0; k < n; k++) {
    const s = acx * (hull[k][1] - a[1]) - acy * (hull[k][0] - a[0]);
    if (s > sMax) {
      sMax = s;
      kMax = k;
    }
    if (s < sMin) {
      sMin = s;
      kMin = k;
    }
  }
  if (sMax <= 0 || sMin >= 0) return null;
  return [a, hull[kMax], c, hull[kMin]].map((p) => [p[0], p[1]]);
}

/** Orden horario (en pantalla) empezando por el de menor x+y. */
function orderCorners(q) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const s = [...q].sort((p, r) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(r[1] - cy, r[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[start][0] + s[start][1]) start = i;
  return [0, 1, 2, 3].map((k) => s[(start + k) % 4]);
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Ajusta una recta (PCA) a los puntos de borde de cada lado y las intersecta. */
function refine(quad, pts) {
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const p = quad[k];
    const q = quad[(k + 1) % 4];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const L = Math.hypot(dx, dy);
    if (L < 4) return quad;
    const ux = dx / L;
    const uy = dy / L;
    const tol = Math.max(2.0, 0.03 * L);
    let n = 0;
    let mx = 0;
    let my = 0;
    const sel = [];
    for (const pt of pts) {
      const rx = pt[0] - p[0];
      const ry = pt[1] - p[1];
      const t = rx * ux + ry * uy;
      const dist = Math.abs(-uy * rx + ux * ry);
      if (dist < tol && t > 0.15 * L && t < 0.85 * L) {
        sel.push(pt);
        mx += pt[0];
        my += pt[1];
        n++;
      }
    }
    if (n < 4) return quad;
    mx /= n;
    my /= n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const pt of sel) {
      const ex = pt[0] - mx;
      const ey = pt[1] - my;
      sxx += ex * ex;
      sxy += ex * ey;
      syy += ey * ey;
    }
    // autovector del mayor autovalor de [[sxx, sxy], [sxy, syy]]
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ p: [mx, my], d: [Math.cos(theta), Math.sin(theta)] });
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const l1 = lines[(k + 3) % 4];
    const l2 = lines[k];
    const det = l1.d[0] * -l2.d[1] - -l2.d[0] * l1.d[1];
    if (Math.abs(det) < 1e-6) return quad;
    const bx = l2.p[0] - l1.p[0];
    const by = l2.p[1] - l1.p[1];
    const t = (bx * -l2.d[1] - -l2.d[0] * by) / det;
    out.push([l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]]);
  }
  const diag = Math.hypot(quad[2][0] - quad[0][0], quad[2][1] - quad[0][1]);
  for (let k = 0; k < 4; k++) {
    if (Math.abs(out[k][0] - quad[k][0]) > 0.1 * diag || Math.abs(out[k][1] - quad[k][1]) > 0.1 * diag) return quad;
  }
  return out;
}

/**
 * Busca el marco en una imagen chica (tipicamente LOCATE_WIDTH de ancho).
 * @returns {{quad: number[][]|null, status: "ok"|"cut"|"none"}} esquinas en
 *   coordenadas de esa imagen (bordes de pixel), orden horario desde arriba-izquierda
 */
export function locateFrame(small) {
  const { width: w, height: h } = small;
  const mask = magentaMask(small);
  const grown = dilate3x3(mask, w, h);
  const { labels, stats } = components(grown, w, h);
  const cands = stats.slice(1).sort((a, b) => b.area - a.area).slice(0, MAX_CANDIDATES);
  let status = "none";
  for (const c of cands) {
    if (c.area < MIN_AREA_FRACTION * w * h) break;
    if (c.x <= 0 || c.y <= 0 || c.x + c.w >= w || c.y + c.h >= h) {
      status = "cut";
      continue;
    }
    const { pts, area } = rowExtremes(labels, mask, c.lab, w, h, c);
    if (area < 8) continue;
    let quad = quadFromHull(convexHull(pts));
    if (!quad) continue;
    quad = orderCorners(quad);
    const qa = quadArea(quad);
    if (qa <= 0 || area / qa < RING_FILL_MIN || area / qa > RING_FILL_MAX) continue;
    const sides = [0, 1, 2, 3].map((k) => Math.hypot(quad[(k + 1) % 4][0] - quad[k][0], quad[(k + 1) % 4][1] - quad[k][1]));
    if (Math.min(...sides) < 12 || Math.max(...sides) / Math.min(...sides) > 3.0) continue;
    return { quad: refine(quad, pts), status: "ok" };
  }
  return { quad: null, status };
}

/** Esquinas del interior del marco a partir de las exteriores. */
export function interiorCorners(outer) {
  const H = computeHomography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    outer
  );
  const b = BORDER;
  return [
    [b, b],
    [1 - b, b],
    [1 - b, 1 - b],
    [b, 1 - b],
  ].map(([x, y]) => applyHomography(H, x, y));
}

function bilinear(img, x, y, out, o) {
  const { data, width, height } = img;
  // mismas convenciones que cv2.warpPerspective: centro de pixel en coordenada entera, BORDER_REPLICATE
  if (x < 0) x = 0;
  else if (x > width - 1) x = width - 1;
  if (y < 0) y = 0;
  else if (y > height - 1) y = height - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * width + x0) * 4;
  const i01 = (y0 * width + x1) * 4;
  const i10 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] + (data[i01 + c] - data[i00 + c]) * fx;
    const bot = data[i10 + c] + (data[i11 + c] - data[i10 + c]) * fx;
    out[o + c] = top + (bot - top) * fy;
  }
  out[o + 3] = 255;
}

/**
 * Recorte size x size del interior del marco (homografia + bilineal).
 * @param {{data, width, height}} img imagen de trabajo
 * @param {number[][]} outer esquinas exteriores en coordenadas de img
 */
export function cropInterior(img, outer, size) {
  const inner = interiorCorners(outer);
  const H = computeHomography(
    [
      [0, 0],
      [size, 0],
      [size, size],
      [0, size],
    ],
    inner
  );
  const out = new Uint8ClampedArray(size * size * 4);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const w = H[6] * u + H[7] * v + H[8];
      const x = (H[0] * u + H[1] * v + H[2]) / w;
      const y = (H[3] * u + H[4] * v + H[5]) / w;
      bilinear(img, x, y, out, (v * size + u) * 4);
    }
  }
  return { data: out, width: size, height: size };
}

/** Recorte central de respaldo (promedio por area). */
export function centerCrop(img, size) {
  const { data, width, height } = img;
  const s = Math.floor(Math.min(width, height) * CENTER_CROP_FRACTION);
  const x0 = Math.floor((width - s) / 2);
  const y0 = Math.floor((height - s) / 2);
  const out = new Uint8ClampedArray(size * size * 4);
  const f = s / size;
  for (let v = 0; v < size; v++) {
    const sy0 = Math.floor(y0 + v * f);
    const sy1 = Math.max(sy0 + 1, Math.floor(y0 + (v + 1) * f));
    for (let u = 0; u < size; u++) {
      const sx0 = Math.floor(x0 + u * f);
      const sx1 = Math.max(sx0 + 1, Math.floor(x0 + (u + 1) * f));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (v * size + u) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: size, height: size };
}

/**
 * Textura del recorte: desvio del residuo tras quitar un plano a la
 * luminancia promediada en una grilla GAP_GRID x GAP_GRID. ~0 en un gap gris
 * (aunque haya reflejo suave o vineteo), alto en un meme.
 */
export function gapResidual(crop) {
  const { data, width: size } = crop;
  const G = GAP_GRID;
  const cell = size / G;
  const g = new Float64Array(G * G);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let s = 0;
      let n = 0;
      for (let y = Math.floor(gy * cell); y < Math.floor((gy + 1) * cell); y++) {
        for (let x = Math.floor(gx * cell); x < Math.floor((gx + 1) * cell); x++) {
          const i = (y * size + x) * 4;
          s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      }
      g[gy * G + gx] = s / n;
    }
  }
  let mean = 0;
  for (const v of g) mean += v;
  mean /= g.length;
  let sxx = 0;
  let bx = 0;
  let by = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const cx = gx - (G - 1) / 2;
      const cy = gy - (G - 1) / 2;
      bx += g[gy * G + gx] * cx;
      by += g[gy * G + gx] * cy;
    }
  }
  for (let i = 0; i < G; i++) sxx += (i - (G - 1) / 2) ** 2;
  bx /= sxx * G;
  by /= sxx * G;
  let ss = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const r = g[gy * G + gx] - mean - bx * (gx - (G - 1) / 2) - by * (gy - (G - 1) / 2);
      ss += r * r;
    }
  }
  return Math.sqrt(ss / g.length);
}
