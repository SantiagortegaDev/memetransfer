#!/usr/bin/env python3
"""
Detecta memes duplicados o casi-duplicados dentro de una carpeta usando
el mismo criterio (hash perceptual + distancia de Hamming) que despues
usara el receptor para reconocer memes por camara.

No borra nada: solo agrupa y reporta para que decidas cual conservar.

Uso:
    python3 scripts/find_similar_memes.py memes/
    python3 scripts/find_similar_memes.py memes/ --threshold 8
    python3 scripts/find_similar_memes.py memes/ --hash-size 16 --json out.json
"""

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
    import imagehash
except ImportError:
    print(
        "Faltan dependencias. Instalalas con:\n"
        "  pip install Pillow imagehash\n",
        file=sys.stderr,
    )
    sys.exit(1)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def compute_hashes(folder: Path, hash_size: int):
    hashes = {}
    errors = []
    paths = sorted(p for p in folder.rglob("*") if p.suffix.lower() in IMAGE_EXTS)
    for path in paths:
        try:
            with Image.open(path) as img:
                img = img.convert("RGB")
                hashes[path] = imagehash.phash(img, hash_size=hash_size)
        except Exception as e:
            errors.append((path, str(e)))
    return hashes, errors


def union_find_groups(paths, are_similar):
    parent = {p: p for p in paths}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    n = len(paths)
    for i in range(n):
        for j in range(i + 1, n):
            if are_similar(paths[i], paths[j]):
                union(paths[i], paths[j])

    groups = {}
    for p in paths:
        groups.setdefault(find(p), []).append(p)
    return [g for g in groups.values() if len(g) > 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Carpeta con los memes")
    parser.add_argument(
        "--threshold",
        type=int,
        default=6,
        help="Distancia de Hamming maxima para considerar 'parecidos' (default: 6)",
    )
    parser.add_argument(
        "--hash-size",
        type=int,
        default=16,
        help="Tamano del hash perceptual (default: 16, igual que se usaria en la app)",
    )
    parser.add_argument(
        "--json",
        type=Path,
        default=None,
        help="Si se pasa, tambien escribe el resultado en este archivo JSON",
    )
    args = parser.parse_args()

    if not args.folder.is_dir():
        print(f"No existe la carpeta: {args.folder}", file=sys.stderr)
        sys.exit(1)

    hashes, errors = compute_hashes(args.folder, args.hash_size)
    if errors:
        print("Archivos que no se pudieron leer:")
        for path, msg in errors:
            print(f"  - {path}: {msg}")
        print()

    if len(hashes) < 2:
        print("No hay suficientes imagenes validas para comparar.")
        return

    paths = list(hashes.keys())

    def are_similar(a, b):
        return (hashes[a] - hashes[b]) <= args.threshold

    groups = union_find_groups(paths, are_similar)

    if not groups:
        print(f"No se encontraron memes parecidos (umbral={args.threshold}).")
        print(f"Total analizados: {len(paths)}")
        return

    print(f"Se encontraron {len(groups)} grupo(s) de memes parecidos "
          f"(umbral={args.threshold}, hash_size={args.hash_size}):\n")

    report = []
    for idx, group in enumerate(groups, 1):
        # Ordena por tamano de archivo descendente: sugiere conservar el
        # de mayor resolucion/calidad (asumiendo que pesa mas = mejor).
        group_sorted = sorted(group, key=lambda p: p.stat().st_size, reverse=True)
        keep = group_sorted[0]
        remove = group_sorted[1:]

        print(f"Grupo {idx}: {len(group_sorted)} imagenes")
        for p in group_sorted:
            dist_to_keep = "" if p == keep else f" (distancia a la sugerida: {hashes[p] - hashes[keep]})"
            marker = "[CONSERVAR sugerido]" if p == keep else "[posible duplicado]"
            print(f"  {marker} {p} ({p.stat().st_size} bytes){dist_to_keep}")
        print()

        report.append({
            "keep_suggested": str(keep),
            "remove_candidates": [str(p) for p in remove],
            "files": [str(p) for p in group_sorted],
        })

    total_removable = sum(len(g) - 1 for g in groups)
    print(f"Total de imagenes 'sobrantes' si aceptas todas las sugerencias: {total_removable}")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(f"\nReporte guardado en: {args.json}")


if __name__ == "__main__":
    main()
