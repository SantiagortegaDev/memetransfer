// Perceptual hash (pHash) basado en DCT-II.
//
// Sustituye al sistema de marcadores visuales (esquinas + tira de bits): en
// vez de dibujar marcadores encima del meme y leerlos bit por bit, calcula
// una "huella" de 256 bits de la imagen completa y la compara contra las
// huellas pre-calculadas de los memes del diccionario. La distancia de
// Hamming entre huellas dice que tan parecidas son dos imagenes: 0 =
// identicas, valores chicos = muy parecidas, valores grandes = distintas.
//
// pHash es robusto a cambios de brillo/contraste (la DCT es casi
// invariante a ganancia/bias global), a escala (se redimensiona a un
// tamano fijo antes de la DCT) y a pequeñas distorsiones de perspectiva
// (las frecuencias bajas que codifica son las mas estables). NO es robusto
// a rotaciones grandes ni a recortes severos.
//
// Version 2: hash de 16x16 = 256 bits (antes 8x8 = 64 bits). Mas bits =
// mas discriminante (la distancia entre memes distintos es mas grande) y
// mas robusto al ruido de camara (un bit mal leido pesa menos sobre el
// total). La DCT sigue siendo sobre 32x32 (4x mas pixeles que antes) para
// dar mas frecuencia de informacion al hash.

const HASH_SIZE = 16; // 16x16 = 256 bits
const INPUT_SIZE = 32; // 32x32 entrada a la DCT

// Tabla de cosenos pre-computada: cosTable[n * INPUT_SIZE + k] =
// cos((2n+1) * k * pi / (2 * INPUT_SIZE)). Se calcula una sola vez al
// cargar el modulo.
const cosTable = new Float64Array(INPUT_SIZE * INPUT_SIZE);
for (let n = 0; n < INPUT_SIZE; n++) {
  for (let k = 0; k < INPUT_SIZE; k++) {
    cosTable[n * INPUT_SIZE + k] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * INPUT_SIZE));
  }
}

/**
 * DCT-II 2D separable: primero DCT por filas, despues por columnas.
 * @param {Float64Array} input INPUT_SIZE*INPUT_SIZE valores
 * @returns {Float64Array}
 */
function dct2d(input) {
  const N = INPUT_SIZE;
  const temp = new Float64Array(N * N);
  // DCT por filas
  for (let y = 0; y < N; y++) {
    const rowOffset = y * N;
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        sum += input[rowOffset + x] * cosTable[x * N + u];
      }
      temp[rowOffset + u] = sum;
    }
  }
  // DCT por columnas
  const output = new Float64Array(N * N);
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        sum += temp[y * N + u] * cosTable[y * N + v];
      }
      output[v * N + u] = sum;
    }
  }
  return output;
}

const HASH_BYTES = (HASH_SIZE * HASH_SIZE) >> 3; // 256 bits / 8 = 32 bytes

/**
 * Calcula el pHash de 256 bits a partir de un ImageData de 32x32.
 * Pensada para ser llamada despues de que el llamador ya dibujo lo que
 * quiera hashear en el canvas de trabajo. Esto permite al receptor
 * dibujar el frame de camara (con crop, rotacion, etc.) antes de hashear,
 * y al diccionario dibujar imagenes pre-cargadas antes de hashearlas.
 *
 * @param {Uint8ClampedArray} rgba datos RGBA de un ImageData 32x32
 * @returns {Uint8Array} 32 bytes (256 bits) - el hash
 */
export function hashFromImageData(rgba) {
  // Convierte a grises y centra los valores restando la media (esto hace
  // que la componente DC sea ~0, y la DCT quede dominada por la estructura
  // de la imagen en vez de por el brillo global).
  const gray = new Float64Array(INPUT_SIZE * INPUT_SIZE);
  let mean = 0;
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = lum;
    mean += lum;
  }
  mean /= INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
    gray[i] -= mean;
  }

  const dct = dct2d(gray);

  // Toma las primeras HASH_SIZE x HASH_SIZE frecuencias (esquina superior
  // izquierda de la DCT), saltando la DC (que es ~0 despues de centrar).
  // Estas frecuencias bajas son las mas estables ante ruido de camara,
  // leves distorsiones de perspectiva y cambios de iluminacion.
  const values = new Float64Array(HASH_SIZE * HASH_SIZE - 1);
  let idx = 0;
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      if (x === 0 && y === 0) continue; // salta DC
      values[idx++] = dct[y * INPUT_SIZE + x];
    }
  }

  // Umbral = mediana. pHash clasico: bit=1 si valor > mediana.
  const sorted = Float64Array.from(values).sort();
  const median = sorted[Math.floor(sorted.length / 2)];

  const hash = new Uint8Array(HASH_BYTES);
  for (let i = 0; i < values.length; i++) {
    if (values[i] > median) {
      const byteIdx = i >> 3; // i / 8
      const bitIdx = i & 7; // i % 8
      hash[byteIdx] |= 1 << (7 - bitIdx); // MSB primero dentro de cada byte
    }
  }
  return hash;
}

/**
 * Calcula el pHash de 256 bits de una imagen/video dibujandola en un
 * canvas chico (32x32) y aplicando DCT-II 2D. Atajo para cuando el
 * llamador no necesita hacer crop ni transformaciones antes de hashear.
 *
 * @param {HTMLCanvasElement} canvas canvas de trabajo (se sobreescribe a 32x32)
 * @param {CanvasRenderingContext2D} ctx contexto del canvas
 * @param {CanvasImageSource} source imagen/video a hashear
 * @param {number} sourceWidth ancho de la fuente (para video, videoWidth)
 * @param {number} sourceHeight alto de la fuente
 * @returns {Uint8Array} 32 bytes (256 bits) - el hash
 */
export function computePHash(canvas, ctx, source, sourceWidth, sourceHeight) {
  if (canvas.width !== INPUT_SIZE || canvas.height !== INPUT_SIZE) {
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
  }
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  return hashFromImageData(data);
}

/**
 * Distancia de Hamming entre dos hashes de 32 bytes (cuantos bits difieren).
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number} 0..256
 */
export function hammingDistance(a, b) {
  let count = 0;
  for (let i = 0; i < HASH_BYTES; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      count += x & 1;
      x >>>= 1;
    }
  }
  return count;
}

// Tamano del canvas de trabajo que computePHash espera (32x32). El
// receptor lo usa para configurar su canvas de trabajo.
export const PHASH_INPUT_SIZE = INPUT_SIZE;
// Numero de bytes del hash (32) - exportado para que el receptor pueda
// validar tamano de hashes pre-calculados.
export const PHASH_BYTES = HASH_BYTES;
// Tamano del hash en bits por lado (16x16). Exportado para diagnostico.
export const PHASH_HASH_SIZE = HASH_SIZE;
