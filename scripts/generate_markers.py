#!/usr/bin/env python3
"""
Genera las 256 imagenes finales que muestra el emisor: cada uno de los
memes originales (memes/manifest.json) con un marcador tipo QR simplificado
superpuesto (4 esquinas blancas + una tira de 8 bits datos + 4 bits de
firma) que codifica su propio indice (0-255) como byte. Ademas genera 2
imagenes de CONTROL (start.jpg, end.jpg) que delimitan la transmision,
con la misma pinta pero una firma distinta que nunca coincide con la de
datos (ver CONTROL_SYNC_BITS en este archivo y js/marker.js).

Las constantes de layout (CORNER_SIZE, CORNER_MARGIN, tira de bits) tienen
que coincidir exactamente con js/marker.js - si se cambia un valor aca hay
que cambiarlo alla tambien (y viceversa), y volver a correr este script.

Uso:
    python3 scripts/generate_markers.py
"""

import json
from pathlib import Path
from PIL import Image, ImageDraw

DESIGN_SIZE = 320

# Deben coincidir con js/marker.js
CORNER_SIZE = 0.09
CORNER_MARGIN = 0.02
BIT_COUNT = 8  # bits de datos (el byte 0-255)
REPEAT = 3  # repeat each data bit for robustness
SYNC_BITS = [1, 0, 1, 0]  # firma fija de DATOS, identica en los 256 marcadores
CONTROL_SYNC_BITS = [0, 1, 0, 1]  # firma fija de CONTROL (inicio/fin), complemento de SYNC_BITS
START_BYTE = 0xAA  # 170
END_BYTE = 0x55  # 85
TOTAL_MODULES = BIT_COUNT + len(SYNC_BITS)
BIT_STRIP_X_START = CORNER_MARGIN + CORNER_SIZE + 0.02
BIT_STRIP_X_END = 1 - CORNER_MARGIN - CORNER_SIZE - 0.02
BIT_MODULE_WIDTH = (BIT_STRIP_X_END - BIT_STRIP_X_START) / TOTAL_MODULES
BIT_STRIP_Y_CENTER = 1 - CORNER_MARGIN - CORNER_SIZE / 2
BIT_MODULE_HEIGHT = CORNER_SIZE * 0.7

MEME_AREA = (0.13, 0.13, 0.87, 0.90)  # x0, y0, x1, y1 normalizados


def px(*coords):
    return tuple(round(c * DESIGN_SIZE) for c in coords)


def paste_cover(base, meme_img, box_norm):
    x0, y0, x1, y1 = px(*box_norm)
    box_w, box_h = x1 - x0, y1 - y0
    meme_ratio = meme_img.width / meme_img.height
    box_ratio = box_w / box_h
    if meme_ratio > box_ratio:
        new_h = box_h
        new_w = round(new_h * meme_ratio)
    else:
        new_w = box_w
        new_h = round(new_w / meme_ratio)
    resized = meme_img.resize((new_w, new_h), Image.LANCZOS)
    crop_x = (new_w - box_w) // 2
    crop_y = (new_h - box_h) // 2
    cropped = resized.crop((crop_x, crop_y, crop_x + box_w, crop_y + box_h))
    base.paste(cropped, (x0, y0))


def draw_corner_squares(draw):
    half = CORNER_SIZE / 2
    centers = [
        (CORNER_MARGIN + half, CORNER_MARGIN + half),
        (1 - CORNER_MARGIN - half, CORNER_MARGIN + half),
        (CORNER_MARGIN + half, 1 - CORNER_MARGIN - half),
        (1 - CORNER_MARGIN - half, 1 - CORNER_MARGIN - half),
    ]
    for cx, cy in centers:
        x0, y0 = px(cx - half, cy - half)
        x1, y1 = px(cx + half, cy + half)
        draw.rectangle([x0, y0, x1, y1], fill="white")


def draw_bit_strip(draw, byte_value, sync_bits=SYNC_BITS):
    data_bits = [(byte_value >> (BIT_COUNT - 1 - i)) & 1 for i in range(BIT_COUNT)]
    # repeat each data bit REPEAT times
    repeated_data = []
    for b in data_bits:
        repeated_data.extend([b] * REPEAT)
    modules = repeated_data + list(sync_bits)
    half_h = BIT_MODULE_HEIGHT / 2
    half_w = (BIT_MODULE_WIDTH * 0.85) / 2  # deja un pequeño espacio visible entre módulos
    for i, bit in enumerate(modules):
        cx = BIT_STRIP_X_START + BIT_MODULE_WIDTH * (i + 0.5)
        cy = BIT_STRIP_Y_CENTER
        x0, y0 = px(cx - half_w, cy - half_h)
        x1, y1 = px(cx + half_w, cy + half_h)
        draw.rectangle([x0, y0, x1, y1], fill="white" if bit else "black")

def render_marker(meme_img, byte_value, sync_bits, out_path):
    meme_img = meme_img.convert("RGB")
    canvas = Image.new("RGB", (DESIGN_SIZE, DESIGN_SIZE), "black")
    paste_cover(canvas, meme_img, MEME_AREA)
    draw = ImageDraw.Draw(canvas)
    draw_corner_squares(draw)
    draw_bit_strip(draw, byte_value, sync_bits)
    # JPEG en vez de PNG: ~4x mas liviano. La lectura de bits promedia
    # brillo sobre un area (no pixel a pixel), asi que tolera bien el ruido
    # de compresion de una imagen bien comprimida (calidad alta, sin
    # sub-muestreo de croma ya que es basicamente blanco/negro puro en las
    # zonas que importan).
    canvas.save(out_path, quality=92)


def main():
    project_root = Path(__file__).resolve().parent.parent
    memes_dir = project_root / "memes"
    manifest = json.loads((memes_dir / "manifest.json").read_text())

    if len(manifest) != 256:
        raise SystemExit(f"Se esperaban 256 memes en el manifest, hay {len(manifest)}")

    out_dir = memes_dir / "marked"
    out_dir.mkdir(exist_ok=True)

    for index, filename in enumerate(manifest):
        with Image.open(memes_dir / filename) as meme_img:
            render_marker(meme_img, index, SYNC_BITS, out_dir / f"{index}.jpg")

        if (index + 1) % 32 == 0 or index == 255:
            print(f"  {index + 1}/256")

    print(f"Listo: {out_dir}/0.jpg .. 255.jpg")

    # Marcadores de CONTROL (inicio/fin de transmision): misma pinta que un
    # marcador de datos (esquinas + foto real con textura en el centro, para
    # pasar el mismo chequeo de textura), pero con la firma de CONTROL en
    # vez de la de datos, asi el receptor nunca los confunde con un byte.
    with Image.open(memes_dir / manifest[0]) as start_img:
        render_marker(start_img, START_BYTE, CONTROL_SYNC_BITS, out_dir / "start.jpg")
    with Image.open(memes_dir / manifest[1]) as end_img:
        render_marker(end_img, END_BYTE, CONTROL_SYNC_BITS, out_dir / "end.jpg")
    print(f"Listo: {out_dir}/start.jpg, {out_dir}/end.jpg")


if __name__ == "__main__":
    main()
