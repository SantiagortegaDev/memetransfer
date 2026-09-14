# Meme Transfer — Diseño v1

## Objetivo

Página web estática (sin backend) que transfiere mensajes cortos de texto/URL
entre dos dispositivos usando la cámara: un dispositivo emisor muestra una
secuencia de memes en pantalla (cada meme = 1 byte), y un dispositivo receptor
apunta su cámara a la pantalla y decodifica el mensaje reconociendo qué meme
del diccionario compartido se está mostrando en cada momento.

Hosteada en GitHub Pages, repo público `memetransfer`.

## No-objetivos (fuera de alcance v1)

- Transferencia bidireccional o canal de confirmación (ACK) entre dispositivos.
- Corrección de errores automática (Reed-Solomon). Solo checksum + reintento manual.
- Mensajes de más de 255 bytes payload (~100-200 caracteres según acentos/UTF-8).
- Soporte offline completo tipo PWA instalable (se agrega cache básica vía Service
  Worker para velocidad, pero no es un requisito de instalación).

## Arquitectura

Un único sitio estático, sin build step:

```
index.html          shell de la UI (modo Enviar / Recibir)
style.css            estilos
app.js                toda la lógica: diccionario, protocolo, phash, envío, recepción
sw.js                 service worker (cache-first para memes/ y assets estáticos)
memes/*.jpg           256 imágenes (ya descargadas, índice 0-255 según orden de manifest)
scripts/find_similar_memes.py   herramienta de dev para detectar memes duplicados (ya existe)
.nojekyll             evita procesamiento Jekyll de GitHub Pages
README.md             instrucciones de uso
```

## Diccionario y protocolo de datos

- 256 memes = alfabeto completo de 1 byte (índice 0-255 == valor del byte).
- No se reservan imágenes especiales de inicio/fin (se evita desperdiciar
  símbolos): la sincronización se logra con tiempos, no con imágenes dedicadas
  (ver "Sincronización" abajo).
- Estructura del mensaje transmitido (todo en bytes, cada byte = 1 meme):

  ```
  [LEN] [payload bytes... (LEN bytes, texto en UTF-8)] [CRC-8]
  ```

  - `LEN`: 1 byte, cantidad de bytes del payload (máx 255).
  - `CRC-8`: checksum estándar (poly 0x07, init 0x00) sobre `LEN + payload`.
- El receptor válida el CRC-8 al terminar. Si no coincide, muestra error y
  pide reintentar; el emisor tiene un botón "Reenviar" que repite la secuencia
  completa sin tener que re-teclear el mensaje.

## Sincronización (sin imágenes dedicadas de start/end)

- Emisor: al tocar "Enviar" hace cuenta regresiva de 3s, luego muestra una
  pausa gris/neutra "larga" (~800ms) como señal de "atención, arranca ya" y
  después la secuencia: `meme(LEN)` → pausa gris corta (~150ms) →
  `meme(byte1)` → pausa → ... → `meme(CRC-8)` → pausa gris final. Al terminar
  muestra un aviso "Enviado" + botón "Reenviar".
- Receptor: arranca en estado `IDLE` (cámara activa pero sin acumular datos).
  Solo empieza a decodificar cuando detecta un meme estable inmediatamente
  después de una pausa gris **larga** (> ~500ms) — eso es lo que distingue
  "inicio real de transmisión" de ruido ambiental. A partir de ahí, cada
  símbolo estable seguido de una pausa gris corta es el siguiente byte, hasta
  completar `1 + LEN + 1` bytes (LEN + payload + CRC).
- Si en cualquier momento aparece un frame que no matchea ningún meme del
  diccionario con confianza suficiente donde se esperaba uno, o pasa demasiado
  tiempo sin resolución, el receptor cancela, vuelve a `IDLE` y muestra
  "No se pudo leer, reintentá" (usuario pide reenvío al emisor).

## Reconocimiento de imagen (pHash)

- Hash perceptual (pHash) calculado en el navegador con Canvas/DCT, sin
  librerías externas: resize a 40x40 en escala de grises → DCT-II → bloque
  10x10 de baja frecuencia (excluyendo DC) → umbral por mediana → hash de
  100 bits.
- Elegido tras medir separación real entre los 256 memes descargados
  (`scripts/find_similar_memes.py` + análisis con `imagehash`):

  | hash_size | bits | distancia mín. entre memes | media |
  |---|---|---|---|
  | 8  | 64  | 14 (21.9%) | 31.0 |
  | **10** | **100** | **28 (28.0%)** | **49.0** |
  | 12 | 144 | 40 (27.8%) | 71.0 |
  | 16 | 256 | 90 (35.2%) | 127.0 |

  Se eligió `hash_size=10` (100 bits) como balance entre margen de separación
  (28 bits mínimos entre cualquier par de memes) y costo de cómputo por frame
  en JS (~40x40 DCT, corre cómodo a 8-10 fps en un celular de gama media).
- Umbral de aceptación inicial: distancia de Hamming ≤ 14 bits (la mitad del
  mínimo separación real) — valor de partida, ajustable en código
  (`MATCH_THRESHOLD` en `app.js`) durante las pruebas manuales.
- Confirmación por estabilidad: un candidato se acepta como símbolo válido
  recién tras N frames consecutivos (~3, a la tasa de muestreo elegida) con
  el mismo mejor-match y distancia bajo el umbral. Esto, sumado a la
  exigencia de la pausa gris entre símbolos, evita: (a) que un objeto
  cualquiera del entorno dispare una detección falsa, y (b) que un mismo
  meme mostrado por error se cuente dos veces.

## UI / Interacción

- Un solo `index.html` con selector de modo arriba: **Enviar** / **Recibir**.
- **Enviar**: textarea (contador de caracteres, límite ~100), botón "Enviar",
  pantalla de cuenta regresiva, pantalla completa de reproducción de memes
  con barra de progreso (byte actual / total), botón "Reenviar" al terminar.
- **Recibir**: botón "Activar cámara", preview de video, si
  `enumerateDevices()` detecta 2+ cámaras aparece un botón "Cambiar cámara"
  (alterna `facingMode`/`deviceId`, prioriza trasera por defecto en celulares).
  Barra de progreso mientras decodifica, resultado final con el texto
  recibido (URLs auto-detectadas y clickeables/copiables), o mensaje de error
  con opción de reintentar.

## Carga rápida y cache

- Al cargar la página se precargan las 256 imágenes (~2.9MB total, ~9KB
  promedio c/u) como `ImageBitmap` en memoria, con una barra de progreso de
  carga inicial, y se calculan sus 256 hashes una sola vez (quedan en un
  array `DICTIONARY` en memoria para toda la sesión).
- `sw.js` (Service Worker) cachea agresivamente (`cache-first`) los assets
  estáticos y `memes/*.jpg`, para que visitas repetidas carguen instantáneo
  incluso con conexión mala, sin necesidad de instalar nada como PWA.

## Manejo de errores

- CRC-8 inválido al final → error de transmisión, reintento manual (ver
  Sincronización).
- Cámara no disponible / permiso denegado → mensaje claro pidiendo permisos.
- Mensaje de emisor > límite de bytes → aviso en la UI antes de poder enviar.
- Timeout de recepción (empezó a decodificar pero no llegó a completar en
  tiempo razonable, ej. 20s) → vuelve a `IDLE` con mensaje de error.

## Testing

Sin backend ni lógica de negocio compleja: validación manual con dos
dispositivos (o dos ventanas de navegador + celular apuntando a un monitor),
probando:
- Mensajes cortos y en el límite de tamaño.
- Buena/mala iluminación, ángulo de cámara.
- Calibración de `MATCH_THRESHOLD` y tiempos de frame (`FRAME_MS`,
  `GAP_MS`) hasta lograr lecturas consistentes sin falsos positivos.

## Despliegue

- Repo público `memetransfer` en GitHub (cuenta ya autenticada vía `gh`).
- GitHub Pages sirviendo desde `main` / raíz (`/`), sin Actions ni build.
