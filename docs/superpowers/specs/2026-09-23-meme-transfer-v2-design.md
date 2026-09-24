# Meme Transfer v2: diseño

Reemplaza al diseño v1 (2026-09-14): reconocimiento por hashes/embeddings
genéricos, marcadores tipo QR y receptor nativo Android.

## Por qué fallaron los intentos anteriores

1. **Se reconocía sin localizar primero.** pHash/dHash y los embeddings de
   MobileNet preentrenada se calculaban sobre el frame entero o sobre un
   recorte fijo del 80%. Bisel, fondo, moiré y exposición dominaban la
   firma, y había falsos positivos con memes de bajo contraste.
2. **Nunca se entrenó con capturas de pantallas hechas con cámara.** Los
   descriptores genéricos (ImageNet, ORB) no aprenden a ignorar moiré,
   reflejos ni perspectiva.
3. **El protocolo era frágil.** Un byte mal leído o perdido rompía el mensaje
   (CRC-8 sin corrección), y la sincronización dependía de N lecturas iguales
   seguidas.
4. Los marcadores QR funcionaban, pero el dato viajaba en los bits y no en el
   meme, y eso contradecía la idea del proyecto.

## Decisiones

| Tema | Decisión |
|---|---|
| Plataforma | Solo web/PWA en GitHub Pages; se borra Android |
| Marco | Liso, magenta #FF00AA, 6% del lado, sin datos; solo sirve para localizar |
| Reconocimiento | Clasificador propio de 259 clases (256 bytes + START + END + NONE) |
| Datos de entrenamiento | 100% sintéticos (render del emisor + cámara simulada), generados con el **mismo** localizador que usa la web |
| Protocolo | Reed-Solomon GF(256) (~25% de paridad, mínimo 4) + CRC-16 + votación entre pasadas del loop |
| Inferencia | ONNX Runtime Web, backend WASM (SIMD), 1 hilo |

## Emisor (`js/sender.js`)

- Canvas negro con un cuadrado centrado de lado `0.92 × min(ancho, alto)`,
  marco magenta de `6%` del lado y el meme **estirado** al interior. Se
  estira porque así se usan todos los píxeles, y el modelo se entrena con esa
  misma deformación.
- Secuencia `START, codeword..., END` con un gap gris (#808080) entre
  símbolos, en loop hasta tocar «Detener». El marco también se muestra
  durante el gap, así el recorte del gap es gris puro y la exposición de la
  cámara no salta.
- Velocidades: lenta 700+200 ms, normal 500+150 ms, rápida 320+110 ms.
- La temporización se engancha a `requestAnimationFrame` con el reloj real,
  sin cadenas de `setTimeout`. Usa Wake Lock y pantalla completa.

## Localizador (`js/locator.js` = `training/common.py`)

1. El frame de trabajo se toma a 640 px de ancho y se reduce a 320 promediando
   bloques de 2×2 (idéntico a `cv2.INTER_AREA`).
2. Máscara magenta: tono entre 280° y 352°, croma ≥ 40 y saturación ≥ 0.35.
3. Dilatación 3×3 (reconecta un anillo cortado por moiré o reflejo) y
   componentes conexos con 8 vecinos.
4. De los 3 componentes más grandes se toma el primero que cumpla todo esto:
   - no toca el borde de la imagen; si lo toca, el estado es `cut` y la UI
     pide alejarse;
   - tiene forma de anillo: píxeles / área del cuadrilátero entre 0.10 y 0.45
     (el anillo ideal da 0.2256);
   - la relación entre sus lados es ≤ 3.
5. Cuadrilátero: el diámetro de la envolvente convexa da dos esquinas opuestas,
   y el punto más lejano a cada lado de esa diagonal da las otras dos. Después
   se refina ajustando una recta (PCA) a los puntos de cada lado y
   cortándolas entre sí.
6. Homografía (`js/homography.js`) → recorte S×S del **interior** del marco
   (S = 160 en el modelo de CPU, lo define `labels.json`). Si no se encuentra
   el marco, se usa un recorte central del 80%.
7. **Gap:** textura residual del recorte, calculada como el desvío de la
   luminancia en una grilla de 16×16 después de restarle un plano. Si es < 3,
   es gap seguro (no se llama al modelo); si es < 10 y el modelo dice NONE
   con p ≥ 0.5, también es gap.

Como el marco no tiene orientación, el recorte puede salir rotado 90°, por
ejemplo si el receptor está en horizontal. El modelo se entrena con las 4
rotaciones.

Un test verifica que las constantes JS y Python sean iguales
(`test/layout-sync.test.js`). Otro corre el localizador JS sobre imágenes
generadas en Python y compara esquinas, recortes y textura
(`test/locator.test.js`).

## Clasificador

- MobileNetV3 (torchvision, preentrenada en ImageNet) con la cabeza cambiada
  por 259 clases. La normalización de ImageNet va dentro del grafo, así que la
  entrada es RGB en [0,1] (NCHW).
- Hay dos configuraciones:
  - **CPU (contenedor):** Small a 160 px, pool de 100k muestras, 10 épocas.
  - **Colab (T4):** Large a 224 px (`training/memetransfer_train.ipynb`).
- AdamW, label smoothing 0.1, LR coseno con warmup, más un aumento barato de
  brillo, contraste y color por batch.
- Export ONNX opset 17. Cuantización int8 estática QDQ por canal, calibrada con
  muestras sintéticas; se usa si pierde ≤ 0.5 puntos de precisión, y si no
  queda fp32.
- **Aceptación por frame:** `p_top1 ≥ 0.6` y `p_top1 − p_top2 ≥ 0.3`. Si no se
  cumple, el frame es incierto.

### Dataset sintético (`training/synth.py`)

Cada muestra se arma así:
1. **Contenido.**
   - Positivas: el meme dentro del marco. Un 8% se mezcla con gris
     (α 0.7-0.95), como en una transición que todavía se reconoce.
   - NONE (12%): gap gris, pantalla negra o blanca, mezcla de dos memes
     (α 0.3-0.7), meme+gris (α 0.1-0.45), o nada de pantalla.
2. **Pantalla.** El cuadrado va sobre una pantalla negra con bisel de color
   aleatorio. Con probabilidad 0.45 se agrega una rejilla de subpíxeles RGB
   que produce moiré real al remuestrear. Brillo y gamma del panel aleatorios.
3. **Pose 3D.** Yaw y pitch de ±35°, roll de ±25° (a veces ±60°), el marco
   ocupa entre el 30% y el 92% del lado corto, desplazamiento de ±15%, y
   fondos procedurales o con memes distractores. A veces un "dedo" tapa una
   parte.
4. **Cámara.**
   - Moiré sinusoidal y bandas de refresco.
   - Reflejo radial, exposición, balance de blancos, gamma y viñeteo.
   - Desenfoque óptico base más desenfoque de foco y de movimiento.
   - Ruido, pérdida de color y JPEG (calidad 35-95).
5. **Localizador real** sobre esa imagen, con jitter en las esquinas (1% del
   lado, a veces 3%).
   - Si el localizador falla, se usa el recorte central, y la etiqueta pasa a
     NONE si el meme cubre menos de la mitad del recorte.
   - Si el localizador encontró otra cosa (error > 20% de la diagonal), la
     etiqueta también pasa a NONE.
6. Rotación aleatoria de 0, 90, 180 o 270°.

## Segmentación (`js/segmenter.js`)

- Un **slot** es un tramo de frames que no son gap. Su clase se decide por
  votación ponderada por probabilidad, contando solo los frames aceptados que
  no son NONE. Si no hay ninguno, el slot es un **borrado** (se sabe que hubo
  un símbolo pero no cuál). Un solo frame incierto suelto no genera un slot.
- **Split por cambio de clase.** Si aparece una racha de 3 frames confiables de
  otra clase sin un gap en medio, es porque se perdió un gap entre dos memes
  distintos, y el slot se parte.
- **Tiempos.** El periodo es la mediana de las distancias entre inicios de
  slot, y también se calcula la duración mediana de un slot.
  - Si un slot arranca unos 2 periodos después del anterior, falta un slot en
    el medio. Si el anterior duró el doble, fue un gap perdido entre dos memes
    iguales (como en "ll") y se duplica; si no, se inserta un borrado.
  - Si el salto supera 6 periodos, se reporta un corte (`break`).
- **Merge-back.** Los slots se emiten con un slot de retraso. Si el siguiente
  empieza a menos de 0.55 periodos y tiene la misma clase (o alguno de los dos
  es un borrado), se unen. Esto cubre el caso de un frame suelto marcado como
  gap en medio de un meme.

## Protocolo y receptor (`js/protocol.js`, `js/rs.js`, `js/receiver.js`)

- `codeword = RS( [LEN, payload…, CRC16_hi, CRC16_lo] )` con
  `paridad = max(4, ceil(k/3))`, o sea ~25% de `n`.
  - `n ≤ 255`, así que el payload máximo es de 188 bytes.
  - `n ↔ LEN` es biyectivo, así que el receptor puede deducir el largo
    contando los slots.
- No hace falta entrelazado: hay un solo bloque RS, que corrige símbolos
  (bytes), así que una ráfaga de errores cuesta lo mismo que errores sueltos.
- RS corrige `2·errores + borrados ≤ paridad` (Forney + Berlekamp-Massey +
  Chien). Está verificado contra `reedsolo`.
- **Pasadas.**
  - Completa: START…END.
  - Cabeza: START sin END.
  - Cola: END sin START, que es lo que pasa cuando el receptor se engancha a
    mitad.
- **Decodificación**, que se intenta después de cada slot:
  1. Largos candidatos: los de las pasadas completas y el que indica el LEN
     leído.
  2. Votos por posición. Las pasadas con el largo justo se alinean directo;
     las que tienen hasta 4 slots de más o de menos se alinean con
     programación dinámica contra el consenso.
  3. **GMD:** se prueba RS borrando los 0, 2, 4, … símbolos menos confiables,
     hasta agotar la paridad.
  4. Último recurso: si una pasada tiene exactamente un slot de menos o de
     más, se prueba cada posición de inserción o borrado.
  5. El resultado solo se acepta si el LEN coincide y el **CRC-16** es
     correcto.

## Verificación

- `npm test`: RS (errores y borrados en el límite), protocolo, segmentador
  (jitter, frames inciertos, gaps perdidos, "ll", oclusión, cortes),
  receptor (enganche a mitad, votación, GMD, slots de más o de menos, 40
  flujos ruidosos, basura sin falsos positivos), calibración, localizador
  (incluida la paridad con Python) y sincronización de constantes.
- `npm run e2e`: Playwright con Chromium headless.
  - El emisor dibuja el marco.
  - El receptor decodifica un video sintético (`training/make_video.py`), tanto
    como archivo como a través de una cámara falsa de Chrome.
  - La consola queda sin errores.
- `training/eval_video.py`: precisión por frame sobre un video real del modo
  Calibrar. Criterio: ≥ 98% de frames correctos entre los aceptados y < 1% de
  aceptaciones falsas.
- Pendiente para el usuario: dos teléfonos reales (Android Chrome + iPhone
  Safari), mensajes de 10, 50 y 150 caracteres, luz buena y media, a 20-40 cm
  y con ángulo.
