# Meme Transfer

Transferí texto o URLs cortas entre dos dispositivos mostrando una
secuencia de memes en pantalla: un dispositivo emisor los reproduce, el
otro los lee con la cámara y los decodifica. Sin backend, sin apps nativas
— una sola página web.

Cada meme se muestra **limpio, sin marcadores encima**. El receptor
identifica cada meme por su contenido visual usando **pHash** (perceptual
hash basado en DCT-II 2D de 64 bits) en vez de un sistema de marcadores
visuales (esquinas + tira de bits). Las imágenes de control `start.jpg`
y `end.jpg` delimitan la transmisión, también identificadas por pHash.

Ver el diseño original en [docs/superpowers/specs/2026-09-14-meme-transfer-design.md](docs/superpowers/specs/2026-09-14-meme-transfer-design.md)
(la versión actual cambia el mecanismo de detección pero mantiene el
mismo framing de protocolo).

## Cómo funciona

1. **Emisor**: codifica el mensaje en bytes (UTF-8 + CRC-8), muestra una
   secuencia de memes. Cada byte 0-255 corresponde a un meme del
   diccionario (256 memes). Antes y después de los bytes de datos,
   muestra `memes/start.jpg` y `memes/end.jpg` (patrones visuales
   simples) para delimitar la transmisión.

2. **Receptor**: en cada frame de cámara (cada ~120ms), busca el mejor
   match probando **5 rotaciones** × **6 escalas** × **3×3 offsets** = 270
   combinaciones de recorte del frame. Para cada combinación, calcula el
   pHash (DCT-II 2D de 256 bits) y lo compara contra los 258 hashes del
   diccionario (256 memes + start + end). Reporta el mejor match si está
   a una distancia de Hamming menor a 60 bits (de 256). SymbolStream filtra
   ruido (exige 3 ticks estables para confirmar un símbolo) y
   FrameAssembler arma la trama completa cuando ve START ... bytes ...
   END.

   Esta búsqueda exhaustiva compensa que el meme no esté perfectamente
   centrado, derecho, ni con un zoom específico — el usuario solo tiene
   que apuntar la cámara aproximadamente al meme.

3. El resultado es el texto decodificado, o un error si el CRC no
   coincide o se agota el timeout.

## Uso

1. Abrí la página en los dos dispositivos (misma URL, ej. GitHub Pages).
2. En el receptor, pestaña **Recibir**: activá la cámara. Queda escuchando todo el tiempo.
3. En el emisor, pestaña **Enviar**: escribí el mensaje (hasta 100 caracteres) y tocá "Enviar".
4. Apuntá la cámara al meme completo. **Tratá de mantener la cámara
   derecha** (sin rotar más de ~3-4 grados) y que el meme llene
   aproximadamente la guía cuadrada del centro del frame.
5. Si da error de checksum, tocá "Reenviar" en el emisor y "Reintentar" en el receptor.

Activando "Modo debug" en el receptor aparece un panel con el log
detallado de cada frame analizado (categoría, byte leído, distancia de
Hamming al mejor candidato), copiable o descargable — útil para
diagnosticar por qué no detecta algo en un celular en particular.

## Desarrollo local

```bash
python3 -m http.server 8080
```

Y abrí `http://localhost:8080`.

### Tests

La lógica de protocolo, CRC, pHash y detección de símbolos tiene tests
unitarios en Node (sin dependencias):

```bash
npm test
```

### Verificación de pHash (sin cámara)

`scripts/test_phash.js` verifica que los 256 memes tengan hashes
distintos y calcula la distancia mínima entre pares (debe ser > 10 para
que el threshold funcione). Requiere `canvas` instalado:

```bash
npm install
node scripts/test_phash.js
```

`scripts/test_phash_camera_simulation.js` simula transformaciones de
cámara (brillo, contraste, escala, rotación, blur) y verifica que el
pHash del resultado siga matcheando al meme original con multi-escala:

```bash
node scripts/test_phash_camera_simulation.js
```

### Regenerar las imágenes de control

Si cambiás algo del layout de las imágenes de control (`memes/start.jpg`
o `memes/end.jpg`), regenerá las dos imágenes finales:

```bash
python3 scripts/generate_control_images.py
```

Esto dibuja `memes/start.jpg` (mitad blanca arriba, mitad negra abajo) y
`memes/end.jpg` (mitad blanca izquierda, mitad negra derecha).

### Cambiar el umbral de match

El umbral de distancia de Hamming está en `js/receiver.js`:
`MATCH_THRESHOLD = 60`. Subirlo si ves falsos negativos en la práctica
(memeres correctos que no se detectan); bajarlo si ves falsos positivos
(memes mal identificados). La distancia mínima entre dos memes distintos
del diccionario es ~84 bits, así que el umbral puede llegar hasta ~75
sin riesgo de falsos positivos.
