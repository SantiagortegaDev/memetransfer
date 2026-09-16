# Meme Transfer

Transferí texto o URLs cortas entre dos dispositivos mostrando una secuencia
de memes en pantalla: un dispositivo emisor los reproduce, el otro los lee
con la cámara y los decodifica. Sin backend, sin apps nativas — una sola
página web.

Cada meme lleva un marcador propio (inspirado en QR) con 4 esquinas blancas
y una tira de 8 bits que codifica directamente su byte — el receptor ubica
las esquinas, corrige la perspectiva de la cámara, y lee los bits. No hay
reconocimiento por parecido de imagen ni diccionario de hashes.

Ver el diseño completo en [docs/superpowers/specs/2026-09-14-meme-transfer-design.md](docs/superpowers/specs/2026-09-14-meme-transfer-design.md).

## Uso

1. Abrí la página en los dos dispositivos (misma URL, ej. GitHub Pages).
2. En el receptor, pestaña **Recibir**: activá la cámara. Queda escuchando todo el tiempo.
3. En el emisor, pestaña **Enviar**: escribí el mensaje (hasta 100 caracteres) y tocá "Enviar".
4. Apuntá la cámara al meme completo (con su marco y esquinas) — no hace falta un encuadre perfecto.
5. Si da error de checksum, tocá "Reenviar" en el emisor y "Reintentar" en el receptor.

Activando "Modo debug" en el receptor aparece un panel con el log detallado
de cada frame analizado (categoría, byte leído, brillo), copiable o
descargable — útil para diagnosticar por qué no detecta algo en un celular
en particular.

## Desarrollo local

```bash
python3 -m http.server 8080
```

Y abrí `http://localhost:8080`.

### Tests

La lógica de protocolo, CRC, homografía, marcador y detección de símbolos
tiene tests unitarios en Node (sin dependencias):

```bash
npm test
```

### Regenerar los memes con marcador

Si cambiás algo del layout del marcador (`js/marker.js`) o agregás/quitás
memes de `memes/` (necesita exactamente 256, ver `memes/manifest.json`),
regenerá las 256 imágenes finales que muestra el emisor:

```bash
python3 scripts/generate_markers.py
```

Esto lee `memes/*.jpg` + `memes/manifest.json` y escribe
`memes/marked/0.jpg` .. `255.jpg` (meme + marco + esquinas + bits). Las
constantes de layout en `scripts/generate_markers.py` tienen que coincidir
exactamente con las de `js/marker.js` — si cambiás una, cambiá la otra.

### Chequeo opcional: memes de bajo contraste

Un meme casi todo blanco/negro puede tener un pHash inestable si en algún
momento se vuelve a usar reconocimiento por imagen. Ya no es necesario para
el marcador actual, pero el script sigue disponible:

```bash
pip install --user Pillow imagehash
python3 scripts/find_similar_memes.py memes/
```
