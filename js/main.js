import { loadDictionary } from "./dictionary.js";
import { listVideoInputs, startCamera, stopCamera } from "./camera.js";
import { encodeMessage } from "./protocol.js";
import { playFrame } from "./sender.js";
import { Receiver } from "./receiver.js";

const ERROR_MESSAGES = {
  "checksum-mismatch": "Error de transmisión (los datos no coinciden). Pedí que se reenvíe.",
  "frame-too-short": "Error de transmisión. Pedí que se reenvíe.",
  timeout: "Se agotó el tiempo esperando la transmisión completa. Intentá de nuevo.",
  "engine-load-failed": "No se pudo cargar el motor de reconocimiento de imágenes (revisá tu conexión) e intentá de nuevo.",
};

const ENGINE_LOADING_LABELS = {
  opencv: "Cargando OpenCV.js...",
  features: "Cargando referencias de los memes...",
};

function $(id) {
  return document.getElementById(id);
}

/** Arma un fragmento con el texto recibido, convirtiendo URLs en links, sin usar innerHTML. */
function linkify(text) {
  const fragment = document.createDocumentFragment();
  const urlPattern = /https?:\/\/[^\s]+/g;
  let lastIndex = 0;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const a = document.createElement("a");
    a.href = match[0];
    a.textContent = match[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    fragment.appendChild(a);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

async function main() {
  const loadingScreen = $("loading-screen");
  const loadingProgress = $("loading-progress");
  const loadingCount = $("loading-count");
  const app = $("app");

  let dictionary;
  try {
    dictionary = await loadDictionary({
      onProgress: (loaded, total) => {
        loadingProgress.max = total;
        loadingProgress.value = loaded;
        loadingCount.textContent = `${loaded} / ${total}`;
      },
    });
  } catch (err) {
    loadingScreen.textContent = `No se pudo cargar el diccionario de memes: ${err.message}`;
    return;
  }

  loadingScreen.classList.add("hidden");
  app.classList.remove("hidden");

  setupModeTabs();
  setupSendPanel(dictionary);
  setupReceivePanel();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // el cache offline es una mejora, no algo critico: si falla, la app sigue funcionando
    });
  }
}

function setupModeTabs() {
  const tabSend = $("tab-send");
  const tabReceive = $("tab-receive");
  const panelSend = $("panel-send");
  const panelReceive = $("panel-receive");

  tabSend.addEventListener("click", () => {
    tabSend.classList.add("active");
    tabReceive.classList.remove("active");
    panelSend.classList.remove("hidden");
    panelReceive.classList.add("hidden");
  });

  tabReceive.addEventListener("click", () => {
    tabReceive.classList.add("active");
    tabSend.classList.remove("active");
    panelReceive.classList.remove("hidden");
    panelSend.classList.add("hidden");
  });
}

function setupSendPanel(dictionary) {
  const input = $("message-input");
  const charCount = $("char-count");
  const btnSend = $("btn-send");
  const sendError = $("send-error");
  const sendStage = $("send-stage");
  const memeScreen = $("meme-screen");
  const sendProgress = $("send-progress");
  const sendStatus = $("send-status");
  const btnResend = $("btn-resend");

  let lastFrame = null;

  input.addEventListener("input", () => {
    charCount.textContent = String(new TextEncoder().encode(input.value).length);
  });

  function showBlank() {
    memeScreen.replaceChildren();
  }

  function showMeme(image) {
    memeScreen.replaceChildren(image.cloneNode());
  }

  async function runSend(frame) {
    btnSend.disabled = true;
    btnResend.disabled = true;
    sendStage.classList.remove("hidden");
    memeScreen.classList.remove("hidden");
    sendProgress.max = frame.length;
    sendProgress.value = 0;
    sendStatus.textContent = "Enviando...";
    await playFrame({
      startImage: dictionary.startImage,
      endImage: dictionary.endImage,
      dictionary: dictionary.memes,
      frame,
      showBlank,
      showMeme,
      onProgress: (shown, total) => {
        sendProgress.value = shown;
        sendStatus.textContent = `Enviando... ${shown}/${total} memes`;
      },
    });

    // Se oculta el recuadro (en vez de dejarlo en gris) para no dejar un
    // fondo plano innecesario en pantalla una vez terminado el envio.
    memeScreen.classList.add("hidden");
    sendStatus.textContent = "Enviado ✔";
    btnSend.disabled = false;
    btnResend.disabled = false;
    btnResend.classList.remove("hidden");
  }

  btnSend.addEventListener("click", async () => {
    sendError.classList.add("hidden");
    try {
      lastFrame = encodeMessage(input.value);
    } catch (err) {
      sendError.textContent = err.message;
      sendError.classList.remove("hidden");
      return;
    }
    await runSend(lastFrame);
  });

  btnResend.addEventListener("click", async () => {
    if (lastFrame) await runSend(lastFrame);
  });
}

function setupReceivePanel() {
  const btnToggle = $("btn-camera-toggle");
  const btnSwitch = $("btn-camera-switch");
  const video = $("camera-preview");
  const progress = $("receive-progress");
  const status = $("receive-status");
  const resultBox = $("receive-result");
  const resultText = $("receive-text");
  const btnCopy = $("btn-copy");
  const errorBox = $("receive-error");
  const errorText = $("receive-error-text");
  const btnRetry = $("btn-retry");
  const debugPanel = $("debug-panel");
  const debugThumb = $("debug-thumb");
  const debugThumbCtx = debugThumb.getContext("2d");
  const debugCategory = $("debug-category");
  const debugDetail = $("debug-detail");
  const chkDebugMode = $("chk-debug-mode");
  const debugLogPanel = $("debug-log-panel");
  const debugLogTextarea = $("debug-log");
  const debugLogCount = $("debug-log-count");
  const btnLogCopy = $("btn-log-copy");
  const btnLogDownload = $("btn-log-download");
  const btnLogClear = $("btn-log-clear");

  let logLines = [];
  const sessionStart = { t: 0 };

  function appendLogLine(info) {
    const elapsed = ((performance.now() - sessionStart.t) / 1000).toFixed(2);
    const details =
      info.decodedIndex !== null
        ? `idx=${info.decodedIndex}`
        : info.cornersFound
          ? "pantalla=si sin-match"
          : "pantalla=no";
    logLines.push(
      `[${elapsed}s] categ=${info.category ?? "GAP"} ${details} inliers=${info.inliers} t=${info.elapsedMs.toFixed(0)}ms`.trim()
    );
    if (logLines.length > 5000) logLines.shift();
    debugLogTextarea.value = logLines.join("\n");
    debugLogTextarea.scrollTop = debugLogTextarea.scrollHeight;
    debugLogCount.textContent = `${logLines.length} líneas`;
  }

  btnLogCopy.addEventListener("click", () => navigator.clipboard.writeText(logLines.join("\n")));
  btnLogDownload.addEventListener("click", () => {
    const blob = new Blob([logLines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `memetransfer-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });
  btnLogClear.addEventListener("click", () => {
    logLines = [];
    debugLogTextarea.value = "";
    debugLogCount.textContent = "0 líneas";
  });

  chkDebugMode.addEventListener("change", () => {
    debugLogPanel.classList.toggle("hidden", !chkDebugMode.checked);
    if (chkDebugMode.checked) {
      sessionStart.t = performance.now();
      logLines = [];
      debugLogTextarea.value = "";
      debugLogCount.textContent = "0 líneas";
    }
  });

  const CATEGORY_LABELS = {
    START: "🟢 Inicio detectado",
    END: "⚫ Fin detectado",
    MATCH: "✅ Meme identificado",
    UNMATCHED: "❓ Pantalla detectada, sin identificar",
    GAP: "⏸️ Pausa / fondo (sin pantalla)",
  };

  function showDebug(info) {
    const { category, decodedIndex, cornersFound, inliers, elapsedMs, canvas } = info;
    debugPanel.classList.remove("hidden");
    debugThumbCtx.drawImage(canvas, 0, 0, debugThumb.width, debugThumb.height);

    debugCategory.textContent = CATEGORY_LABELS[category] ?? CATEGORY_LABELS.GAP;

    const parts = [];
    if (decodedIndex !== null) {
      parts.push(`índice: ${decodedIndex}`, `inliers: ${inliers}`);
    } else if (cornersFound) {
      parts.push(`pantalla aislada, sin match confiable (inliers: ${inliers})`);
    } else {
      parts.push("sin pantalla detectada");
    }
    parts.push(`${elapsedMs.toFixed(0)} ms`);
    debugDetail.textContent = parts.join(" · ");

    if (chkDebugMode.checked) appendLogLine(info);
  }

  let stream = null;
  let receiver = null;
  let videoInputs = [];
  let currentDeviceIndex = 0;

  function resetResultUi() {
    resultBox.classList.add("hidden");
    errorBox.classList.add("hidden");
    progress.classList.remove("hidden");
    progress.value = 0;
    status.textContent = "Esperando el inicio de una transmisión...";
  }

  function startReceiving() {
    receiver = new Receiver({
      videoEl: video,
      onProgress: (shown, total) => {
        progress.max = total ?? Math.max(progress.max, shown);
        progress.value = shown;
        status.textContent = total ? `Recibiendo... ${shown}/${total}` : "Recibiendo...";
      },
      onSuccess: (text) => {
        progress.classList.add("hidden");
        status.textContent = "";
        resultBox.classList.remove("hidden");
        resultText.replaceChildren(linkify(text));
        btnCopy.onclick = () => navigator.clipboard.writeText(text);
      },
      onError: (error) => {
        progress.classList.add("hidden");
        status.textContent = "";
        errorBox.classList.remove("hidden");
        errorText.textContent = ERROR_MESSAGES[error] ?? "No se pudo leer la transmisión.";
      },
      onDebug: showDebug,
      onEngineLoading: (loading, stage) => {
        if (loading) status.textContent = ENGINE_LOADING_LABELS[stage] ?? "Cargando reconocimiento de imágenes...";
      },
    });
    resetResultUi();
    receiver.start();
  }

  btnRetry.addEventListener("click", () => {
    receiver?.stop();
    startReceiving();
  });

  btnToggle.addEventListener("click", async () => {
    if (stream) {
      receiver?.stop();
      stopCamera(stream);
      stream = null;
      video.srcObject = null;
      btnToggle.textContent = "Activar cámara";
      btnSwitch.classList.add("hidden");
      progress.classList.add("hidden");
      resultBox.classList.add("hidden");
      errorBox.classList.add("hidden");
      debugPanel.classList.add("hidden");
      status.textContent = "";
      return;
    }

    try {
      stream = await startCamera(video, { facingMode: "environment" });
    } catch (err) {
      errorBox.classList.remove("hidden");
      errorText.textContent = `No se pudo activar la cámara: ${err.message}`;
      return;
    }

    btnToggle.textContent = "Desactivar cámara";

    videoInputs = await listVideoInputs();
    currentDeviceIndex = 0;
    btnSwitch.classList.toggle("hidden", videoInputs.length < 2);

    startReceiving();
  });

  btnSwitch.addEventListener("click", async () => {
    if (videoInputs.length < 2) return;
    currentDeviceIndex = (currentDeviceIndex + 1) % videoInputs.length;
    receiver?.stop();
    stopCamera(stream);
    stream = await startCamera(video, { deviceId: videoInputs[currentDeviceIndex].deviceId });
    startReceiving();
  });
}

main();
