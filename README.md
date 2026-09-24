# Meme Transfer v2

Manda texto o URLs de un teléfono a otro **mostrando una secuencia de memes**:
cada uno de los 256 memes vale 1 byte. Un teléfono los muestra en pantalla y
el otro los reconoce con la cámara. Es una sola página web (PWA), sin backend
y sin apps nativas.

- **Emisor:** cada meme va dentro de un marco magenta liso. El marco no lleva
  datos; solo sirve para ubicarlo. Entre meme y meme hay un gap gris, y la
  secuencia se repite en loop.
- **Receptor:** ubica el marco, corrige la perspectiva, recorta el interior y un
  **clasificador propio de 259 clases** (MobileNetV3, entrenado con capturas
  sintéticas de pantallas) dice qué meme es. El meme se identifica por su
  contenido.
- **Protocolo:** `START · LEN · payload · CRC-16 · paridad Reed-Solomon · END`.
  RS corrige memes mal leídos (errores) y memes perdidos (borrados). Además,
  las pasadas del loop se combinan votando por posición.

Diseño: [docs/superpowers/specs/2026-09-23-meme-transfer-v2-design.md](docs/superpowers/specs/2026-09-23-meme-transfer-v2-design.md) ·
Informe del experimento: [docs/REPORT.md](docs/REPORT.md) ·
Memes a reemplazar: [docs/MEMES_PROBLEMATICOS.md](docs/MEMES_PROBLEMATICOS.md)

## Uso

1. Abre la página en los dos teléfonos (GitHub Pages, o `python3 -m http.server`
   en la red local con https).
2. **Receptor → Recibir → Activar cámara.** Puede quedar escuchando antes de
   que empiece la transmisión, o engancharse a mitad.
3. **Emisor → Enviar:** escribe el mensaje (hasta 188 bytes), elige la
   velocidad y toca **Transmitir**. Sube el brillo al máximo.
4. Apunta la cámara al marco magenta (a 20-40 cm, con un poco de ángulo no
   pasa nada). Cuando RS logra decodificar, el texto aparece con **Copiar** y
   los links son clickeables.

**Calibrar:** en un teléfono, «Mostrar secuencia» recorre los 258 memes en
orden. En el otro, «Medir con cámara» muestra en vivo la precisión por meme y
la lista de memes problemáticos. Es la herramienta para validar en hardware real.

**Depuración:** en Recibir, «Cargar video» analiza un video grabado cuadro a
cuadro (en forma determinista) en lugar de la cámara, y el log por frame se
exporta a JSON.

## Estructura

```
index.html · style.css · sw.js · manifest.webmanifest   PWA, sin build step
js/
  main.js          UI (Enviar / Recibir / Calibrar)
  protocol.js      trama y CRC-16            rs.js         Reed-Solomon GF(256)
  sender.js        dibujo y temporización del emisor (loop)
  camera.js        getUserMedia, cámara trasera 1280x720
  layout.js        constantes compartidas con training/common.py
  locator.js       marco magenta → 4 esquinas → homografía → recorte
  homography.js    DLT de 4 puntos
  frame-reader.js  frame → localizador → gap → clasificador → observación
  classifier.js    ONNX Runtime Web (WASM)
  segmenter.js     frames → slots (separados por los gaps grises)
  receiver.js      slots → pasadas → votos → RS → texto
  calibration.js   precisión por meme en el modo Calibrar
lib/ort/           onnxruntime-web 1.30 (solo WASM), copiado para funcionar offline
model/             memes.onnx + labels.json
memes/             256 memes + control-start/end + manifest.json
training/          dataset sintético, entrenamiento, export y evaluación (Python)
test/              node:test + e2e con Playwright
```

## Desarrollo

```bash
python3 -m http.server 8080        # y abre http://localhost:8080
npm test                           # tests unitarios (Node 20+, sin dependencias)
npm install && npm run e2e         # navegador headless con video sintético (necesita Python, ver abajo)
npm run e2e:pwa                    # service worker: precache y decodificación sin conexión
npm run bench                      # mensajes de 10/50/150 caracteres, luz buena y media (videos sintéticos)
```

Los scripts de navegador generan los videos con `training/make_video.py`;
usa `PYTHON=/ruta/al/python` si las dependencias de `training/` están en un venv.

### Entrenar el clasificador

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r training/requirements.txt
python training/synth.py --grid grid.jpg --camera-grid cam.jpg        # revisar el dataset a ojo
python training/train.py --arch small --size 160 --pool 100000 --epochs 10   # CPU (~2-3 h)
python training/export_onnx.py training/runs/latest/best.pt           # -> model/memes.onnx + labels.json
```

Para el modelo grande (MobileNetV3-Large a 224 px) está
[`training/memetransfer_train.ipynb`](training/memetransfer_train.ipynb), para
correr en Google Colab con GPU. La web lee el tamaño de entrada desde
`labels.json`, así que alcanza con reemplazar los dos archivos de `model/`.

### Validar con un video real

Graba con el teléfono receptor un video apuntando al emisor en modo
**Calibrar** y corre:

```bash
python training/eval_video.py video.mp4 --export-crops real_crops/
```

El criterio de aceptación es **≥ 98 % de frames correctos entre los aceptados
y < 1 % de aceptaciones falsas**. Si no se cumple, se hace fine-tuning
mezclando esos recortes reales:
`train.py --init runs/.../best.pt --real real_crops/`.
