# Meme Transfer — Diseño v1

> **Revisión v2 (post-pruebas en celular real):** las secciones de
> Protocolo, Sincronización y pHash de más abajo fueron actualizadas tras
> probar en hardware real. Con una cámara de celular apuntando a otra
> pantalla, el borde/bisel *siempre* entra en cuadro y el enfoque a veces
> falla. Eso hacía que el receptor nunca llegara a confirmar ni el primer
> símbolo (timeout constante). Los cambios: (1) el receptor recorta al 80%
> central del frame antes de analizarlo, ignorando el borde; (2) el
> byte `LEN` se reemplaza por marcadores de inicio/fin explícitos (flash
> blanco/negro, detectados por brillo promedio, no por pHash — mucho más
> robusto a desenfoque); (3) `MATCH_THRESHOLD` subió de 14 a 32 bits tras
> medir que el resampleo de cámara solo (sin distorsión) ya cuesta ~4 bits.

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
- Estructura del mensaje transmitido (todo en bytes, cada byte = 1 meme),
  encerrada entre marcadores de inicio/fin que NO son memes (ver
  "Sincronización" abajo):

  ```
  START  [payload bytes... (texto en UTF-8)] [CRC-8]  END
  ```

  - `CRC-8`: checksum estándar (poly 0x07, init 0x00) sobre el payload.
  - No hay byte de longitud: el receptor cuenta bytes entre START y END, así
    un byte mal leído no descuadra el resto de la trama (con LEN, un solo
    error en el primer byte rompía el largo esperado de todo el mensaje).
- El receptor válida el CRC-8 al llegar el marcador END. Si no coincide,
  muestra error y pide reintentar; el emisor tiene un botón "Reenviar" que
  repite la secuencia completa sin tener que re-teclear el mensaje.

## Sincronización (marcadores explícitos de inicio/fin)

- Emisor: al tocar "Enviar" hace cuenta regresiva de 3s, luego muestra un
  **flash blanco pantalla completa** (~500ms, marcador START) → pausa gris
  corta (~150ms) → `meme(byte1)` → pausa → ... → `meme(CRC-8)` → pausa →
  **flash negro pantalla completa** (~500ms, marcador END). Al terminar
  muestra un aviso "Enviado" + botón "Reenviar".
- Receptor: recorta cada frame de cámara al 80% central antes de analizarlo
  (`CAPTURE_CROP_FRACTION`, coincide con el recuadro guía en la UI), ignorando
  el borde/bisel de pantalla que siempre aparece alrededor en una captura
  real. Cada frame recortado se clasifica por brillo/uniformidad promedio
  (`js/classify.js`), NO por pHash:
  - Uniforme y muy claro (media ≥210, desvío <20) → **START**.
  - Uniforme y muy oscuro (media ≤45, desvío <20) → **END**.
  - Uniforme a mitad de rango → pausa gris (gap, ignorar).
  - Con textura/variación → candidato a meme, recién ahí se calcula el pHash
    y se busca el mejor match contra el diccionario.
  - Esta clasificación por brillo es mucho más robusta a desenfoque que
    intentar reconocer 256 memes: un flash blanco/negro sigue siendo blanco/negro
    aunque la cámara este desenfocada.
  - Ambos marcadores, igual que los bytes, requieren N frames consecutivos
    estables antes de confirmarse (mismo mecanismo de debounce en
    `js/matcher.js`), evitando falsos positivos de un solo frame con ruido.
  - Al confirmarse START, el receptor arranca a acumular bytes desde cero
    (incluso si ya estaba a mitad de una recepción anterior: un reenvío
    siempre "gana" sobre una transmisión previa que quedó colgada). Al
    confirmarse END, se decodifica lo acumulado y se valida el CRC-8.
- Si en cualquier momento pasan más de `PER_SYMBOL_TIMEOUT_MS` (5s) sin un
  símbolo nuevo confirmado tras haber arrancado, el receptor cancela y
  muestra "No se pudo leer, reintentá" (timeout por símbolo, no por mensaje
  completo — así escala solo con mensajes largos en vez de cortarlos a
  mitad de camino).

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
- Umbral de aceptación (`MATCH_THRESHOLD` en `js/receiver.js`): **32 bits**,
  no 14 como se había estimado inicialmente. Medido en el navegador: incluso
  con encuadre perfecto, pasar la imagen por un canvas intermedio (como hace
  una captura de cámara real) ya cuesta ~4 bits de distancia; un mal encuadre
  del ~5% sube eso a 18-30 bits según el meme. `bestMatch` siguió eligiendo
  el meme correcto en todas las pruebas hasta ~35 bits de distancia, y un
  decode erróneo lo atrapa igual el CRC-8 final — así que de nuevo se
  prioriza tolerancia a condiciones reales de cámara por sobre margen de
  seguridad entre memes parecidos (separación mínima real: 28 bits). Sigue
  siendo el primer valor a recalibrar con más pruebas de hardware.
- Confirmación por estabilidad: un candidato (meme o marcador START/END) se
  acepta recién tras N frames consecutivos (~3, a la tasa de muestreo
  elegida) con el mismo resultado. Esto, sumado a la exigencia de una pausa
  gris entre símbolos, evita: (a) que un objeto cualquiera del entorno
  dispare una detección falsa, y (b) que un mismo símbolo mostrado por error
  se cuente dos veces.

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
- Timeout por símbolo (pasaron >5s sin un byte/marcador nuevo tras haber
  arrancado a recibir) → vuelve a `IDLE` con mensaje de error. Es por
  símbolo, no por mensaje completo, para no cortar mensajes largos a mitad
  de camino.

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
