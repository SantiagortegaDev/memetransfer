#!/usr/bin/env python3
"""
Genera las dos imagenes de CONTROL (start.jpg, end.jpg) que delimitan
una transmision. NO son memes: son patrones visuales simples y muy
distintivos, faciles de identificar por pHash sin confundirse con
ningun meme real.

  start.jpg  = mitad superior blanca + mitad inferior negra (corte
               horizontal - alta frecuencia vertical, sin frecuencia
               horizontal).
  end.jpg    = mitad izquierda blanca + mitad derecha negra (corte
               vertical - alta frecuencia horizontal, sin frecuencia
               vertical).

Las dos tienen exactamente la misma cantidad de blanco y negro (mitad
y mitad), asi que un detector de brillo promedio solo no las distingue
- se las distingue por la estructura (frecuencia), no por la cantidad.

Uso:
    python3 scripts/generate_control_images.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

SIZE = 320  # mismo tamano que usaba generate_markers.py


def make_horizontal_split(path):
    """Mitad blanca arriba, mitad negra abajo (start)."""
    img = Image.new("RGB", (SIZE, SIZE), "black")
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, SIZE - 1, SIZE // 2 - 1], fill="white")
    img.save(path, quality=92)


def make_vertical_split(path):
    """Mitad blanca izquierda, mitad negra derecha (end)."""
    img = Image.new("RGB", (SIZE, SIZE), "black")
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, SIZE // 2 - 1, SIZE - 1], fill="white")
    img.save(path, quality=92)


def main():
    project_root = Path(__file__).resolve().parent.parent
    memes_dir = project_root / "memes"
    memes_dir.mkdir(exist_ok=True)

    make_horizontal_split(memes_dir / "start.jpg")
    make_vertical_split(memes_dir / "end.jpg")

    print(f"Listo: {memes_dir}/start.jpg (corte horizontal)")
    print(f"Listo: {memes_dir}/end.jpg (corte vertical)")


if __name__ == "__main__":
    main()
