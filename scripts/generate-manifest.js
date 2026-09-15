#!/usr/bin/env node
// Genera memes/manifest.json: la lista de los 256 archivos de memes en un
// orden fijo (alfabetico), que define el indice = valor de byte de cada
// meme. Emisor y receptor cargan el mismo manifest.json, asi que siempre
// coinciden en que archivo representa cada byte 0-255.
import { readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

async function main() {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const memesDir = path.join(projectRoot, "memes");

  const entries = await readdir(memesDir);
  const files = entries
    .filter((name) => IMAGE_EXTS.has(path.extname(name).toLowerCase()))
    .sort();

  if (files.length !== 256) {
    console.error(
      `Se esperaban 256 memes, se encontraron ${files.length}. Revisa la carpeta memes/ antes de generar el manifest.`
    );
    process.exitCode = 1;
    return;
  }

  const manifestPath = path.join(memesDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(files, null, 2) + "\n");
  console.log(`Escrito ${manifestPath} con ${files.length} entradas (indice 0-255).`);
}

main();
