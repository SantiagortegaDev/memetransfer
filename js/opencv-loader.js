// Carga perezosa de OpenCV.js (WASM): no se importa como modulo ES normal
// porque es un build de Emscripten que expone la variable global `cv`. Se
// inyecta como <script> clasico solo cuando el receptor la necesita (no
// bloquea la carga inicial de la app), y se espera a que el runtime WASM
// termine de inicializarse antes de devolver el objeto `cv`.
let loadPromise = null;

export function loadOpenCv() {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/opencv.js";
    script.onerror = () => reject(new Error("No se pudo cargar OpenCV.js"));
    script.onload = () => {
      const cv = window.cv;
      if (!cv) {
        reject(new Error("OpenCV.js cargo pero no expuso window.cv"));
        return;
      }
      // Si el runtime WASM ya termino de inicializar (build rapido / cache
      // tibia) algunas versiones ya exponen esta funcion de forma sincronica;
      // si no, se espera al callback estandar de Emscripten.
      if (typeof cv.getBuildInformation === "function") {
        resolve(cv);
      } else {
        cv.onRuntimeInitialized = () => resolve(cv);
      }
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}
