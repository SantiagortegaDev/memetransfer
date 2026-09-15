# Meme Transfer

Transferí texto o URLs cortas entre dos dispositivos mostrando una secuencia
de memes en pantalla: un dispositivo emisor los reproduce, el otro los lee
con la cámara y los decodifica. Sin backend, sin apps nativas — una sola
página web.

Ver el diseño completo en [docs/superpowers/specs/2026-09-14-meme-transfer-design.md](docs/superpowers/specs/2026-09-14-meme-transfer-design.md).

## Uso

1. Abrí la página en los dos dispositivos (misma URL, ej. GitHub Pages).
2. En uno, pestaña **Enviar**: escribí el mensaje (hasta 100 caracteres) y tocá "Enviar".
3. En el otro, pestaña **Recibir**: activá la cámara y apuntá a la pantalla del emisor.
4. Esperá la cuenta regresiva de 3s en el emisor y el mensaje aparece decodificado en el receptor.
5. Si da error de checksum, tocá "Reenviar" en el emisor y "Reintentar" en el receptor.

## Desarrollo local

```bash
python3 -m http.server 8080
```

Y abrí `http://localhost:8080`.

### Tests

La lógica de protocolo, CRC, hash perceptual y detección de símbolos tiene
tests unitarios en Node (sin dependencias):

```bash
npm test
```

### Regenerar el diccionario de memes

Si agregás/quitás archivos de `memes/`, regenerá el manifest que fija el
índice (= byte) de cada meme:

```bash
npm run generate-manifest
```

Y revisá que no haya quedado ningún par demasiado parecido (confundiría a la
cámara):

```bash
pip install --user Pillow imagehash
python3 scripts/find_similar_memes.py memes/
```
