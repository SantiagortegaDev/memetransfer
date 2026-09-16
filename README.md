# Meme Transfer

Transferí texto o URLs cortas entre dos dispositivos mostrando una secuencia
de memes en pantalla: un dispositivo emisor los reproduce, el otro los lee
con la cámara y los decodifica. Sin backend, sin apps nativas — una sola
página web.

Los memes se muestran tal cual, sin ningún marcador superpuesto: el
receptor los reconoce por su propio contenido visual. El pipeline (todo en
el navegador, vía [OpenCV.js](https://docs.opencv.org/4.9.0/opencv.js))
aísla la pantalla del emisor dentro del frame de cámara (Canny + contornos +
homografía), extrae features ORB, y hace *retrieve-and-rerank* contra los
descriptores precalculados de los 256 memes + 2 imágenes de control
(inicio/fin): primero cuenta *good matches* (Lowe ratio test) contra cada
candidato, y solo a los mejores les corre verificación geométrica completa
(RANSAC + homografía), aceptando el resultado solo si hay suficientes
inliers y le saca ventaja clara al segundo candidato.

Ver el diseño completo en [docs/superpowers/specs/2026-09-14-meme-transfer-design.md](docs/superpowers/specs/2026-09-14-meme-transfer-design.md).

## Uso

1. Abrí la página en los dos dispositivos (misma URL, ej. GitHub Pages).
2. En el receptor, pestaña **Recibir**: activá la cámara. Queda escuchando todo el tiempo.
3. En el emisor, pestaña **Enviar**: escribí el mensaje (hasta 100 caracteres) y tocá "Enviar".
4. Apuntá la cámara a la pantalla del emisor, encuadrando el meme completo — no hace falta un encuadre perfecto.
5. Si da error de checksum, tocá "Reenviar" en el emisor y "Reintentar" en el receptor.

La primera vez que se activa la cámara del lado receptor, se descarga
OpenCV.js (~10 MB) y las referencias precalculadas (~5 MB); quedan
cacheadas por el service worker para las próximas veces.

Activando "Modo debug" en el receptor aparece un panel con el log detallado
de cada frame analizado (categoría, índice identificado, inliers, tiempo de
cómputo), copiable o descargable — útil para diagnosticar por qué no
detecta algo en un celular en particular.

## Desarrollo local

```bash
python3 -m http.server 8080
```

Y abrí `http://localhost:8080`.

### Tests

La lógica de protocolo, CRC y detección de símbolos tiene tests unitarios
en Node (sin dependencias) — el pipeline de visión (`js/vision.js`) depende
de OpenCV.js y del DOM, así que se prueba en el navegador, no en Node:

```bash
npm test
```

### Regenerar las referencias ORB

Si agregás/quitás memes de `memes/` (necesita exactamente 256, ver
`memes/manifest.json`) o cambiás los parámetros de ORB, hay que
recalcular los descriptores de referencia:

```bash
pip install --user opencv-python-headless numpy
python3 scripts/precompute_features.py
```

Esto lee `memes/*.jpg` + `memes/manifest.json` + `memes/control-start.jpg` +
`memes/control-end.jpg`, y escribe `memes/features.bin` (keypoints +
descriptores binarios) y `memes/features.json` (índice). Las constantes
`CANONICAL_SIZE`/`ORB_NFEATURES` en `scripts/precompute_features.py` tienen
que coincidir exactamente con las de `js/vision.js` — si cambiás una,
cambiá la otra y volvé a correr el script.
