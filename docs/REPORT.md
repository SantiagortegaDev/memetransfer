# Informe: Meme Transfer v2

Reescritura completa hecha en la nube (claude.ai/code) directo sobre `main`,
el 24 de septiembre de 2026. El sitio publicado es
<https://santiagortegadev.github.io/memetransfer/>.

## Resumen

- Se implementó el plan completo:
  - PWA de una sola página para enviar, recibir y calibrar;
  - marco magenta liso;
  - un **clasificador propio de 259 clases** entrenado solo con datos
    sintéticos;
  - un protocolo con **Reed-Solomon + CRC-16 + votación entre pasadas**.
  Se borraron Android y el sistema de marcadores.
- El modelo es **MobileNetV3-Small a 160 px**, entrenado en la CPU del
  contenedor en ~2 h. Pesa 3.5 MB (pesos en fp16) y en Chromium headless
  tarda ~9 ms por frame.
- Resultados **sobre datos sintéticos** (lo único disponible acá):
  - **99.4%** de acierto por frame en memes, y **1 solo caso de meme leído
    como otro meme** en 4688 muestras (3188 de validación + 1500 nuevas), o
    sea 0.02%;
  - el video sintético del modo Calibrar cumple el criterio de aceptación del
    plan con margen: **100% de precisión entre los aceptados y 0% de
    aceptaciones falsas** (el criterio pedía ≥ 98% y < 1%);
  - de punta a punta en el navegador, con cámara falsa y con archivo de video,
    se decodifican mensajes de 10, 50 y 150 caracteres. Con el receptor
    enganchado a mitad de una pasada, alcanza con **menos de una pasada**
    (10 / 36 / 102 s a velocidad normal).
- **Lo que falta y solo puedes hacer tú:** probar con dos teléfonos reales.
  Todo lo anterior es sintético, y la cámara real (exposición automática,
  moiré real, reflejos, enfoque que "caza") es justo donde fallaron los
  intentos anteriores. Hay un checklist al final.

## Qué se hizo, paso por paso del plan

| Paso | Estado | Dónde |
|---|---|---|
| 1. Limpieza + RS/protocolo/segmentador/receptor con tests | ✅ | `js/rs.js`, `js/protocol.js`, `js/segmenter.js`, `js/receiver.js`, `test/` |
| 2. Emisor con marco, gap, loop y calibración | ✅ | `js/sender.js`, pestañas Enviar y Calibrar |
| 3. `training/`: synth, grilla, train, export, notebook de Colab | ✅ | `training/*.py`, `training/memetransfer_train.ipynb` |
| 3b. Modelo entrenado (en CPU; el grande queda para Colab) | ✅ | `model/memes.onnx`, `model/labels.json` |
| 4. Localizador + clasificador + receptor + modo video | ✅ | `js/locator.js`, `js/classifier.js`, `js/frame-reader.js`, `js/main.js` |
| 5. PWA (service worker cache-first), manifest, Wake Lock, GitHub Pages | ✅ | `sw.js`, `manifest.webmanifest`, `icons/` |
| Verificación: `npm test`, `eval_video.py`, navegador | ✅ (sintético) | ver Resultados |
| Prueba en teléfonos reales | ⏳ tuya | checklist al final |

Además del plan:
- `training/make_video.py` genera videos sintéticos temporalmente coherentes
  (pose con temblor de mano, mezclas en las transiciones), sirve de cámara
  falsa para Chrome y trae la línea de tiempo real para evaluar.
- `test/e2e/run.mjs`, `bench.mjs` y `live.mjs`: pruebas de navegador con
  Playwright.
- `training/analyze_val.py`: desglose de errores del modelo.
- `train.py --real DIR`: fine-tuning mezclando recortes reales exportados por
  `eval_video.py --export-crops`, para cuando haya videos de teléfonos.

## Resultados

### Tests unitarios (`npm test`): 64/64 ✅

- **Reed-Solomon:** errores y borrados exactamente en el límite (`2e + f =
  nsym`, 700 casos aleatorios), codeword de 255 símbolos, vector conocido
  idéntico al de `reedsolo`, y falla explícita más allá de la capacidad.
- **Protocolo:** ida y vuelta con acentos y emoji, largo máximo (188 bytes), y
  la biyección entre largo del codeword y LEN.
- **Segmentador:** jitter de tiempos, frames inciertos, gap perdido entre
  memes distintos (se parte por clase) y entre iguales (`ll`, se recupera por
  tiempos), meme tapado (borrado en su lugar), cortes, un frame gris suelto
  (merge-back), START falso de un solo frame y reentrada.
- **Receptor:**
  - enganche a mitad;
  - votación entre pasadas con 2× la capacidad de errores por pasada;
  - GMD;
  - slot de más o de menos;
  - alineación por programación dinámica;
  - sin END;
  - sin START (nunca reconocido);
  - 40 flujos ruidosos;
  - 3000 slots de basura sin ningún falso positivo.
- **Localizador:** geometría y **paridad con Python** (esquinas a < 0.75 px,
  recortes y textura iguales), más la sincronización de constantes JS↔Python.

Stress del receptor sobre 100 flujos simulados por escenario (enganche en un
punto aleatorio, 5 pasadas disponibles):

| Escenario (por frame) | Decodifica | Pasadas necesarias | Decodificaciones erróneas |
|---|---|---|---|
| Fácil: 20 fps, 10% inciertos, 1% errores | 100% | 1 (97%), 2 (3%) | 0 |
| Ruidoso: 12 fps, 30% inciertos, 6% errores, 8% gaps perdidos, 5% memes tapados | 100% | ≤ 2 en el 87%, ≤ 3 en el 99% | 0 |
| Extremo: 8 fps, 40% inciertos, 12% errores, 15% gaps perdidos, 10% tapados | 3% | 4-5 | 0 |

### Entrenamiento (CPU del contenedor, 4 núcleos)

Se usó MobileNetV3-Small (ImageNet) a 160 px. El pool fue de 100k muestras
sintéticas (13 min de generación a ~124 muestras/s), con 10 épocas de ~7 min
cada una. La validación son 4000 muestras sintéticas fijas, que incluyen
casos muy duros: recortes con el localizador errado hasta un 20%, blur y
ruido fuertes.

| Época | Loss | Acierto | Memes | NONE | Precisión aceptados | Acept. falsas | Memes aceptados |
|---|---|---|---|---|---|---|---|
| 1 | 1.593 | 90.4 | 91.3 | 86.5 | 97.0 | 1.98 | 81.1 |
| 3 | 1.129 | 94.9 | 98.0 | 82.9 | 96.5 | 2.62 | 90.5 |
| 5 | 1.058 | 95.9 | 98.2 | 86.8 | 97.3 | 2.08 | 93.6 |
| 8 | 0.968 | 97.0 | 99.1 | 88.5 | 97.7 | 1.82 | 98.1 |
| 10 | 0.943 | 97.1 | 99.1 | 89.4 | 97.8 | 1.75 | 98.0 |
| +4 de fine-tuning | 0.972 | 96.8 | **99.4** | 86.3 | 97.6 | 1.95 | 98.5 |

(Las cifras están en %.)

**Cómo leer las "aceptaciones falsas" de la tabla.** En la validación,
`analyze_val.py` muestra que **todas** son muestras etiquetadas NONE que el
modelo acepta como un meme: mezclas entre dos memes con α ≈ 0.7, o recortes
reetiquetados. En el protocolo esos casos son inofensivos, porque el meme
dominante de una transición vota en su propio slot. Los errores que sí dañan,
**meme → otro meme**, son 0 de 3188 con el modelo base y **1 de 3188** con el
final (el meme 133 leído como START, un efecto colateral de sobremuestrear
START).

**Fine-tuning por START.** El análisis mostró que START solo acertaba el 71%.
`control-start.jpg` son cuadraditos gris claro sobre blanco: tiene poca
textura, se confundía con la clase NONE "pantalla blanca" y a veces caía por
debajo del umbral de gap. Se aplicaron cuatro cambios:
1. se sacó esa NONE;
2. se sobremuestreó START/END;
3. se bajó el umbral de "gap seguro" de 3 a 2;
4. se hicieron 4 épocas de fine-tuning.

Resultado sobre 1500 muestras nuevas: **START sube al 86%**, END queda en
99%, y los memes no cambian (0 casos de meme→otro; en la validación fija
START pasa de 7/13 a 12/13). Además, el receptor ahora
**decodifica aunque START no se reconozca nunca**: deduce el largo de las
pasadas END…END. Y un START tiene que tener 2 frames que lo confirmen, así un
frame suelto no mete un ancla falsa.

**Export.**
- ONNX opset 17, verificado contra PyTorch.
- La **cuantización int8 colapsa** con MobileNetV3: el acierto cae a ~20% con
  QDQ estática por canal (MinMax, Percentile o Entropy), solo en las
  convoluciones, e incluso con cuantización dinámica. Hardswish y los bloques
  SE no toleran los rangos calibrados.
- Se usó en cambio **"fp16w"**: pesos guardados en fp16 con un `Cast` que ORT
  pliega al cargar. Pesa **3.5 MB** (contra 7 MB en fp32), hace el mismo
  cálculo en fp32 y pierde 0.0 puntos. `export_onnx.py` elige
  automáticamente la variante más chica que no pierda precisión.

### Criterio de aceptación: `eval_video.py` sobre el video sintético de Calibrar

El video tiene los 258 memes a velocidad rápida y 15 fps, dificultad media.
En total son 1747 frames, de los cuales 1247 son de meme.

| Etiquetas | Frames aceptados | Precisión entre aceptados | Aceptaciones falsas | Gaps detectados | ¿Cumple? |
|---|---|---|---|---|---|
| Reales (`--truth`) | 99.9% | **100%** | **0%** | 100% | ✅ |
| Inferidas por orden (como con un video real) | 97.9% | **100%** | **0%** | — | ✅ |

El mismo video en el navegador (pestaña Calibrar → Medir video) da 258/258
memes vistos, 100% de slots correctos, 100% de precisión y 0% de
aceptaciones falsas.

### Navegador (Playwright + Chromium headless, `npm run e2e`): 4/4 ✅

| Prueba | Resultado |
|---|---|
| Emisor | Marco #FF00AA exacto, fondo negro, avanza la secuencia |
| Recibir → Cargar video (el receptor entra al 40% de la pasada) | Texto exacto de 60 bytes, con 66 slots |
| Recibir → cámara falsa de Chrome, **en tiempo real** | Texto exacto en 44 s, procesando **30 frames/s** (12 ms por frame, **modelo 9 ms**) |
| Calibrar → Medir video | 258/258, 100% / 100% / 0% |
| PWA (`npm run e2e:pwa`) | El service worker precachea 27 archivos; **sin red** recarga y decodifica |
| GitHub Pages (con `curl`) | Todo responde 200 con los tipos MIME correctos (`application/wasm` y JS para `.mjs`) |

Sin errores de consola en ninguna prueba.

### Prueba final del plan, versión sintética (`npm run bench`)

Velocidad normal (0.5 s por meme + 0.15 s de gap). Cada video empieza en el
37% de una pasada, es decir, el receptor empieza a apuntar tarde.

| Mensaje | Luz | Resultado | Tiempo hasta decodificar | Pasadas | s/pasada | Frames aceptados |
|---|---|---|---|---|---|---|
| 10 caracteres | buena | ✅ | 10.1 s | 0.77 | 13 | 98% |
| 10 caracteres | media | ✅ | 10.1 s | 0.77 | 13 | 98% |
| 50 caracteres | buena | ✅ | 36.3 s | 0.77 | 47.5 | 96% |
| 50 caracteres | media | ✅ | 36.3 s | 0.77 | 47.5 | 95% |
| 150 caracteres | buena | ✅ | 101.9 s | 0.75 | 135 | 100% |
| 150 caracteres | media | ✅ | 101.9 s | 0.75 | 135 | 100% |
| 50 caracteres, difícil (1.5), velocidad rápida | — | ✅ | 24.1 s | — | — | 97% |

Decodifica en menos de una pasada porque RS rellena como borrados los
símbolos que todavía no se vieron. En "buena" y "media" el tiempo sale igual:
si no hay errores de lectura, el momento de decodificar lo fija la estructura
de la trama.

## Desvíos del plan, y por qué

1. **Sin WebGPU.** El backend WebGPU de ORT (jsep) pesa 28 MB (6.6 MB
   comprimido) contra 14 MB (3.7 MB comprimido) del WASM. Para una red de
   ~30 MFLOPs, WASM SIMD ya da ~9 ms por frame. Se incluye solo
   `lib/ort/ort.wasm.min.mjs` + `ort-wasm-simd-threaded.{mjs,wasm}`
   (onnxruntime-web 1.30). Corre en un solo hilo porque GitHub Pages no manda
   COOP/COEP.
2. **Sin int8** (ver Export): se usan pesos fp16 de 3.5 MB.
3. **Modelo de CPU a 160 px en vez de 224.** Entrena 1.6× más rápido y en el
   teléfono cuesta la mitad. El pipeline no depende del tamaño: la web lee
   `input_size` de `labels.json`, así que el modelo Large de 224 del notebook
   de Colab se enchufa reemplazando los dos archivos.
4. **Sin entrelazado.** Hay un solo bloque RS de ≤ 255 símbolos, y RS corrige
   símbolos (bytes), así que una ráfaga cuesta lo mismo que errores sueltos.
   Entrelazar solo sirve con varios bloques.
5. **Entrenamiento con las 4 rotaciones de 90°.** El marco no tiene
   orientación, y si el receptor está en horizontal el recorte sale rotado.
   Así se evita una marca de orientación, que sería "datos en el marco".
6. **Detección de gap combinada.** La textura sola no separa el gris con
   moiré o reflejo de un meme muy degradado. Por eso: textura < 2 es gap
   seguro (sin modelo), y si es < 10 y el modelo dice NONE, también es gap.
7. **Emisión de slots con un slot de retraso (merge-back)** y **correcciones
   por tiempo** en el segmentador (duplicar "ll", borrado para un meme tapado,
   cortes). El plan solo hablaba de "tramos entre gaps"; sin esto, un gap
   perdido desalineaba toda la trama.
8. **Receptor más robusto que el plan:**
   - GMD (borrar primero los símbolos menos confiables);
   - alineación por programación dinámica de pasadas con slots de más o de
     menos;
   - prueba de todos los puntos de inserción o borrado;
   - largo deducido de pasadas END…END.
9. **Velocidad "rápida" de 320 + 110 ms** en lugar de un valor sin definir.
   Las tres velocidades están en `SPEEDS` de `js/sender.js`.
10. **Rama:** todo se hizo en `main`, como pediste, y cada push se replicó en
    la rama de la sesión `claude/eager-galileo-4mqjeh`.

## Limitaciones y riesgos (lo que los datos sintéticos no pueden decir)

- **El dominio real no está probado.** El dataset simula moiré (rejilla de
  subpíxeles + interferencia), reflejos, exposición, desenfoque, ruido, JPEG y
  perspectiva, pero no exposición ni enfoque automáticos que cambian en el
  tiempo, rolling shutter, HDR o procesamiento agresivo del teléfono, ni PWM
  de pantallas OLED a bajo brillo. Si el modelo falla en real, lo previsto es:
  1. grabar un video del modo Calibrar;
  2. correr `eval_video.py --export-crops`;
  3. hacer fine-tuning con `train.py --real`.
  Con unos pocos minutos de video real debería alcanzar.
- **START tiene poco contraste.** `control-start.jpg` sigue siendo el símbolo
  más débil (86% en muestras duras). Se mitigó en el receptor (decodifica
  aunque no lo vea), pero **te recomiendo reemplazar `control-start.jpg` por
  algo de alto contraste** y reentrenar.
- **Los videos sintéticos son más amables que el set de validación**, por eso
  dan 100%. La validación aleatoria (97% global, 99.4% en memes) es la mejor
  estimación de "peor caso" que tengo sin hardware.
- **Rendimiento en iPhone:** 9 ms es en una CPU de servidor con Chromium. En
  un iPhone con WASM de un hilo espero 15-40 ms por frame, muy por debajo del
  umbral de 80 ms del plan. Hay que medirlo: la pestaña Recibir →
  Depuración muestra ms por frame y ms del modelo.
- **Mensaje máximo de 188 bytes.** 150 caracteres a velocidad normal son
  ~2¼ min por pasada.

## Checklist para la prueba en teléfonos reales

1. Abre <https://santiagortegadev.github.io/memetransfer/> en los dos
   (Android Chrome + iPhone Safari). Tiene que decir **v2.0.0**; si no,
   recarga.
2. **Calibrar primero.** Uno toca «Mostrar secuencia» (con velocidad normal
   en Enviar) y el otro «Medir con cámara» a 20-40 cm. Deja pasar la vuelta
   completa (~3 min) y **exporta el JSON**. Mira la precisión, las
   aceptaciones falsas y los memes problemáticos.
3. **Graba un video** con el receptor apuntando al modo Calibrar (con la app
   de cámara) y corre
   `python training/eval_video.py video.mp4 --export-crops real_crops/`. Si no
   cumple (≥ 98% / < 1%), sigue el fine-tuning del README o del notebook.
4. **Mensajes de 10, 50 y 150 caracteres**, con luz buena y media, a 20-40 cm
   y con ángulo. Anota el tiempo y las pasadas (la barra de slots y el texto
   de estado lo muestran). Con «Guardar log de cada frame» activado, exporta
   el log de los casos que fallen.
5. Pasa el rendimiento de Recibir → Depuración (frames/s y ms del modelo) en
   el iPhone.
6. Si algo falla, los JSON exportados más un video corto alcanzan para
   diagnosticar: el modo «Cargar video» reproduce el caso de forma
   determinista.

## Cómo reproducir

```bash
npm test                                   # 64 tests
python3 -m venv .venv && . .venv/bin/activate && pip install -r training/requirements.txt
npm install && PYTHON=.venv/bin/python npm run e2e    # + E2E_CALIBRATION=1 para la calibración
PYTHON=.venv/bin/python npm run bench && npm run e2e:pwa
python training/train.py --arch small --size 160 --pool 100000 --epochs 10 --out training/runs/cpu-small160
python training/train.py --arch small --size 160 --pool 60000 --seed 2 --epochs 4 --lr 6e-4 \
    --init training/runs/cpu-small160/best.pt --out training/runs/cpu-small160-ft
python training/export_onnx.py training/runs/cpu-small160-ft/last.pt
```
