import { loadOpenCv } from "./opencv-loader.js";

// Debe coincidir EXACTO con scripts/precompute_features.py: mismo tamano
// canonico y mismos parametros de ORB, si no los descriptores binarios no
// son comparables por distancia de Hamming entre si.
export const CANONICAL_SIZE = 480;
export const ORB_NFEATURES = 500;

// Umbrales del pipeline "retrieve-and-rerank" (ver research en la
// conversacion): primero se cuenta cuantos matches buenos (Lowe ratio test)
// tiene cada una de las 258 imagenes de referencia contra el frame
// capturado -esto es barato-, y solo a los mejores candidatos se les corre
// la verificacion geometrica cara (homografia + RANSAC), aceptando el
// resultado solo si supera un piso de inliers Y le saca ventaja clara al
// segundo candidato (evita confundir memes visualmente parecidos entre si).
const LOWE_RATIO = 0.75;
const TOP_K_CANDIDATES = 3;
const MIN_GOOD_MATCHES = 10;
const MIN_INLIERS = 10;
const RANSAC_REPROJ_THRESHOLD = 6;
const WINNER_MARGIN_RATIO = 1.3; // el 1ro debe tener al menos 30% mas inliers que el 2do

let cv = null;
let orb = null;
let matcher = null;

/**
 * Inicializa OpenCV.js y las instancias de ORB/BFMatcher (una sola vez).
 * Los bindings de embind de OpenCV.js no soportan argumentos por defecto
 * estilo JS en constructores sobrecargados - hay que pasar TODOS los
 * parametros de forma explicita (son los mismos valores por defecto que
 * usa cv2.ORB_create() en Python, ver scripts/precompute_features.py, para
 * que los descriptores sean comparables entre si).
 */
export async function initVision() {
  if (cv) return cv;
  cv = await loadOpenCv();
  orb = new cv.ORB(
    ORB_NFEATURES, // nfeatures
    1.2, // scaleFactor
    8, // nlevels
    31, // edgeThreshold
    0, // firstLevel
    2, // WTA_K
    cv.ORB_HARRIS_SCORE, // scoreType
    31, // patchSize
    20 // fastThreshold
  );
  matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  return cv;
}

let enginePromise = null;

/**
 * Punto de entrada perezoso usado por el receptor: carga OpenCV.js + los
 * descriptores de referencia una sola vez (cacheado a nivel de modulo, asi
 * activar/reactivar la camara varias veces no vuelve a pagar el costo de
 * inicializar el runtime WASM ni de crear los cv.Mat persistentes).
 * @param {{onProgress?: (stage: "opencv"|"features") => void}} options
 */
export function getVisionEngine({ onProgress } = {}) {
  if (!enginePromise) {
    enginePromise = (async () => {
      await initVision();
      onProgress?.("opencv");
      const referenceFeatures = await loadReferenceFeatures();
      onProgress?.("features");
      return { match: (imageData) => matchFrame(imageData, referenceFeatures) };
    })().catch((err) => {
      enginePromise = null; // permite reintentar si fallo (p.ej. red caida)
      throw err;
    });
  }
  return enginePromise;
}

/**
 * Carga memes/features.json + memes/features.bin (precalculados por
 * scripts/precompute_features.py) y envuelve cada set de descriptores en un
 * cv.Mat persistente (se crea una sola vez, se reutiliza en cada tick del
 * receptor - crear un cv.Mat por candidato en cada tick seria carisimo).
 * @returns {Promise<{index:number|string, count:number, points:Float32Array, descriptors: any}[]>}
 */
export async function loadReferenceFeatures() {
  if (!cv) throw new Error("Llama a initVision() antes de loadReferenceFeatures()");

  const [meta, bin] = await Promise.all([
    fetch("memes/features.json").then((r) => r.json()),
    fetch("memes/features.bin").then((r) => r.arrayBuffer()),
  ]);

  if (meta.canonicalSize !== CANONICAL_SIZE || meta.orbNFeatures !== ORB_NFEATURES) {
    throw new Error("memes/features.json no coincide con los parametros de vision.js - correr scripts/precompute_features.py de nuevo");
  }

  return meta.entries.map((entry) => {
    const points = new Float32Array(bin, entry.pointsOffset, entry.count * 2);
    const descriptorBytes = new Uint8Array(bin, entry.descriptorsOffset, entry.descriptorsLength);
    const descriptors = cv.matFromArray(entry.count, 32, cv.CV_8U, descriptorBytes);
    return { index: entry.index, count: entry.count, points, descriptors };
  });
}

/** Libera los cv.Mat persistentes creados por loadReferenceFeatures(). */
export function disposeReferenceFeatures(referenceFeatures) {
  for (const ref of referenceFeatures) ref.descriptors.delete();
}

/**
 * Busca, dentro de la imagen completa (en escala de grises), el
 * cuadrilatero mas grande y plausible (Canny -> findContours ->
 * approxPolyDP) y devuelve la homografia que lo endereza a un cuadrado
 * canonico de CANONICAL_SIZE x CANONICAL_SIZE, junto con el frame ya
 * "aplanado". Esto aisla la pantalla del celular emisor (quita
 * bisel/fondo/mano) antes de buscar features, que es la mejora de mayor
 * impacto para todo lo que viene despues.
 * @param {any} grayMat cv.Mat CV_8UC1
 * @returns {any|null} cv.Mat CV_8UC1 de CANONICAL_SIZE x CANONICAL_SIZE, o null si no se encontro un cuadrilatero plausible
 */
function findAndWarpScreen(grayMat) {
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  cv.GaussianBlur(grayMat, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 75, 200);
  blurred.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  edges.delete();
  hierarchy.delete();

  const frameArea = grayMat.rows * grayMat.cols;
  let bestQuad = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    // descarta contornos demasiado chicos (ruido) o que ocupan casi todo el
    // frame (probablemente el borde de la propia imagen, no la pantalla)
    if (area < frameArea * 0.08 || area > frameArea * 0.95) {
      contour.delete();
      continue;
    }
    const approx = new cv.Mat();
    const peri = cv.arcLength(contour, true);
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);
    contour.delete();

    if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
      if (bestQuad) bestQuad.delete();
      bestQuad = approx;
      bestArea = area;
    } else {
      approx.delete();
    }
  }
  contours.delete();

  if (!bestQuad) return null;

  const srcPts = [];
  for (let i = 0; i < 4; i++) {
    srcPts.push({ x: bestQuad.intPtr(i, 0)[0], y: bestQuad.intPtr(i, 0)[1] });
  }
  bestQuad.delete();
  const ordered = orderQuadCorners(srcPts);

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    ordered[0].x, ordered[0].y,
    ordered[1].x, ordered[1].y,
    ordered[2].x, ordered[2].y,
    ordered[3].x, ordered[3].y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    CANONICAL_SIZE, 0,
    CANONICAL_SIZE, CANONICAL_SIZE,
    0, CANONICAL_SIZE,
  ]);
  const homography = cv.getPerspectiveTransform(srcTri, dstTri);
  srcTri.delete();
  dstTri.delete();

  const warped = new cv.Mat();
  cv.warpPerspective(grayMat, warped, homography, new cv.Size(CANONICAL_SIZE, CANONICAL_SIZE));
  homography.delete();

  return warped;
}

/** Ordena 4 puntos como [arriba-izq, arriba-der, abajo-der, abajo-izq] por suma/resta de coordenadas (heuristica estandar de "document scanner"). */
function orderQuadCorners(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const topLeft = bySum[0];
  const bottomRight = bySum[3];
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  const topRight = byDiff[0];
  const bottomLeft = byDiff[3];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/**
 * Redimensiona `mat` (cualquier tamano) a un cuadrado CANONICAL_SIZE x
 * CANONICAL_SIZE mantendiendo aspecto (como CSS object-fit: contain), con
 * relleno gris - fallback usado cuando no se encontro un cuadrilatero
 * confiable para enderezar. Sigue intentando el match completo en vez de
 * descartar el frame, tal como recomienda el research: mejor un intento con
 * mas ruido que ninguno.
 */
function fitContainSquare(grayMat) {
  const scale = Math.min(CANONICAL_SIZE / grayMat.cols, CANONICAL_SIZE / grayMat.rows);
  const newW = Math.round(grayMat.cols * scale);
  const newH = Math.round(grayMat.rows * scale);
  const resized = new cv.Mat();
  cv.resize(grayMat, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_AREA);

  const canvas = new cv.Mat(CANONICAL_SIZE, CANONICAL_SIZE, cv.CV_8UC1, new cv.Scalar(128));
  const x0 = Math.round((CANONICAL_SIZE - newW) / 2);
  const y0 = Math.round((CANONICAL_SIZE - newH) / 2);
  const roi = canvas.roi(new cv.Rect(x0, y0, newW, newH));
  resized.copyTo(roi);
  roi.delete();
  resized.delete();
  return canvas;
}

/**
 * Pipeline completo: dado un frame de camara (ImageData RGBA), intenta
 * identificar cual de las imagenes de referencia se esta mostrando.
 * @param {ImageData} imageData
 * @param {{index:number|string, count:number, points:Float32Array, descriptors:any}[]} referenceFeatures
 * @returns {{index:number|string, inliers:number, cornersFound:boolean}|null}
 */
export function matchFrame(imageData, referenceFeatures) {
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();

  const warped = findAndWarpScreen(gray);
  const canonical = warped ?? fitContainSquare(gray);
  const cornersFound = !!warped;
  gray.delete();

  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  orb.detect(canonical, keypoints);
  orb.compute(canonical, keypoints, descriptors);
  canonical.delete();

  if (descriptors.rows === 0) {
    keypoints.delete();
    descriptors.delete();
    return { index: null, inliers: 0, cornersFound };
  }

  // Etapa A (barata): contar "good matches" (Lowe ratio test) contra cada
  // referencia, sin verificacion geometrica todavia.
  const scored = [];
  for (const ref of referenceFeatures) {
    if (ref.count === 0) continue;
    const knnMatches = new cv.DMatchVectorVector();
    matcher.knnMatch(descriptors, ref.descriptors, knnMatches, 2);
    let good = 0;
    const goodPairs = [];
    for (let i = 0; i < knnMatches.size(); i++) {
      const pair = knnMatches.get(i);
      if (pair.size() < 2) continue;
      const m = pair.get(0);
      const n = pair.get(1);
      if (m.distance < LOWE_RATIO * n.distance) {
        good++;
        goodPairs.push(m);
      }
    }
    knnMatches.delete();
    if (good >= MIN_GOOD_MATCHES) scored.push({ ref, good, goodPairs });
  }
  scored.sort((a, b) => b.good - a.good);
  const candidates = scored.slice(0, TOP_K_CANDIDATES);

  // Etapa B (cara, solo para los mejores candidatos): homografia + RANSAC,
  // contando inliers como confirmacion de que es la MISMA imagen (no solo
  // parecida) vista en perspectiva.
  let best = null;
  let runnerUpInliers = 0;
  for (const { ref, goodPairs } of candidates) {
    const srcPts = [];
    const dstPts = [];
    for (const m of goodPairs) {
      const kp = keypoints.get(m.queryIdx);
      srcPts.push(kp.pt.x, kp.pt.y);
      dstPts.push(ref.points[m.trainIdx * 2], ref.points[m.trainIdx * 2 + 1]);
    }
    const srcMat = cv.matFromArray(srcPts.length / 2, 1, cv.CV_32FC2, srcPts);
    const dstMat = cv.matFromArray(dstPts.length / 2, 1, cv.CV_32FC2, dstPts);
    const mask = new cv.Mat();
    const homography = cv.findHomography(srcMat, dstMat, cv.RANSAC, RANSAC_REPROJ_THRESHOLD, mask);
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;
    srcMat.delete();
    dstMat.delete();
    mask.delete();
    homography.delete();

    if (!best || inliers > best.inliers) {
      if (best) runnerUpInliers = best.inliers;
      best = { index: ref.index, inliers };
    } else if (inliers > runnerUpInliers) {
      runnerUpInliers = inliers;
    }
  }

  keypoints.delete();
  descriptors.delete();

  if (!best || best.inliers < MIN_INLIERS) return { index: null, inliers: best?.inliers ?? 0, cornersFound };
  if (runnerUpInliers > 0 && best.inliers < runnerUpInliers * WINNER_MARGIN_RATIO) {
    // dos candidatos casi empatados: demasiado ambiguo (memes muy
    // parecidos entre si), mejor no arriesgar una lectura incorrecta.
    return { index: null, inliers: best.inliers, cornersFound };
  }

  return { index: best.index, inliers: best.inliers, cornersFound };
}
