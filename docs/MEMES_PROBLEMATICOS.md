# Memes problemáticos

Generado por `training/rank_memes.py` con el modelo actual: 150 capturas sintéticas por meme
(mismo simulador que el entrenamiento, semilla fija, así que se puede comparar antes y después).

- Memes con ≥95% leídos bien y sin confusiones: **248/258**.
- Promedio de «aceptado y correcto»: **97.9%**.

**Columnas:** *leído OK* = % de capturas que el receptor acepta con la clase correcta;
*confusión* = % aceptado como **otro** meme (el error grave); *textura* = qué tan poco se parece
al gris del gap después de desenfocar (menos de 4 es riesgoso); *parecido* = similitud con el
meme más parecido según el modelo (más de 0.85 es riesgoso).

## Reemplazar (6)

Estos fallan seguido o se confunden con otro meme.

| Byte | Meme | Archivo | Leído OK | Confusión | Textura | Parecido (con) | Se confunde con | Motivos |
|---|---|---|---|---|---|---|---|---|
| START | <img src="../memes/control-start.jpg" width="64"> | `control-start.jpg` | 81% | 0.0% | 4.3 | 0.35 (25) | NONE ×18 | se lee poco |
| 133 | <img src="../memes/4pn1an.jpg" width="64"> | `4pn1an.jpg` | 81% | 0.7% | 5.9 | 0.40 (159) | NONE ×15, START ×3 | se lee poco, se confunde con otro |
| 122 | <img src="../memes/43a45p.jpg" width="64"> | `43a45p.jpg` | 85% | 0.0% | 17.7 | 0.46 (111) | NONE ×9, 121 ×1 | se lee poco |
| 20 | <img src="../memes/1iruch.jpg" width="64"> | `1iruch.jpg` | 96% | 0.7% | 22.1 | 0.54 (80) | 80 ×2 | se confunde con otro, casi igual a 80 |
| 156 | <img src="../memes/5mcpl.jpg" width="64"> | `5mcpl.jpg` | 90% | 0.0% | 8.6 | 0.42 (143) | NONE ×12 | se lee poco |
| 79 | <img src="../memes/2zj3.jpg" width="64"> | `2zj3.jpg` | 91% | 0.0% | 6.2 | 0.62 (154) | NONE ×8, START ×3 | se lee poco |

## Opcional (5)

Estos funcionan, pero por debajo del resto; reemplazarlos es una mejora menor.

| Byte | Meme | Archivo | Leído OK | Confusión | Textura | Parecido (con) | Se confunde con | Motivos |
|---|---|---|---|---|---|---|---|---|
| 97 | <img src="../memes/3c3uom.jpg" width="64"> | `3c3uom.jpg` | 93% | 0.0% | 10.8 | 0.46 (63) | NONE ×2 | — |
| 80 | <img src="../memes/30b1gx.jpg" width="64"> | `30b1gx.jpg` | 98% | 0.0% | 21.9 | 0.54 (20) | NONE ×1 | duplicado de 20: alcanza con reemplazar uno de los dos |
| 28 | <img src="../memes/1tkjq9.jpg" width="64"> | `1tkjq9.jpg` | 94% | 0.0% | 15.0 | 0.51 (98) | NONE ×3 | — |
| 202 | <img src="../memes/8d8efg.jpg" width="64"> | `8d8efg.jpg` | 94% | 0.0% | 17.5 | 0.44 (73) | NONE ×7 | — |
| 46 | <img src="../memes/29bq.jpg" width="64"> | `29bq.jpg` | 95% | 0.0% | 19.3 | 0.39 (232) | NONE ×4 | — |

El resto (247 memes) se lee bien en ≥95% de las capturas; entre ellos las diferencias son ruido estadístico.
«NONE» en *se confunde con* significa que el modelo dijo «no hay meme» (se pierde ese frame, no es grave);
un número o START/END es un error de verdad.

### Qué hace bueno a un meme para esto

- Mucho contraste y colores variados; que ocupe todo el cuadro (se estira a cuadrado).
- Evitar dibujos de línea fina sobre fondo blanco y fotos apagadas o de un solo tono: con
  desenfoque y reflejo se parecen al gris del gap o a la pantalla vacía.
- Que no sea otra versión de un meme que ya está (misma plantilla, mismos colores).

## Cómo reemplazarlos

1. Pon las imágenes nuevas en `memes/nuevos/`, con el **número de byte** como nombre
   (`17.jpg`, `203.png`…) o `START.jpg` / `END.jpg` para las de control.
2. Antes de reemplazar, revisa que sean buenas candidatas (no necesita reentrenar):
   `python training/rank_memes.py --candidates memes/nuevos`
   Buscan: mucha textura y contraste, colores variados, y que no se parezcan a ningún otro meme.
3. Reemplaza: `python training/replace_memes.py memes/nuevos` (copia los archivos y actualiza `memes/manifest.json`).
4. Reentrena enfocando los memes nuevos (≈30 min en CPU) y exporta:
   `python training/train.py --arch small --size 160 --pool 60000 --seed 3 --epochs 4 --lr 6e-4 --init training/runs/cpu-small160-ft/last.pt --focus <bytes separados por coma> --out training/runs/reemplazo`
   `python training/export_onnx.py training/runs/reemplazo/last.pt`
5. Vuelve a correr `python training/rank_memes.py` y compara con este archivo.
