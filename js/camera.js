// Camara trasera a 1280x720 (o lo mas parecido que ofrezca el telefono),
// con enfoque continuo si el navegador lo permite.

/**
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(videoEl) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Este navegador no da acceso a la cámara (¿la página está en https?).");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
  });
  const [track] = stream.getVideoTracks();
  try {
    const caps = track.getCapabilities?.() ?? {};
    if (caps.focusMode?.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
  } catch {
    // no todos los navegadores lo soportan; no es grave
  }
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Espera el proximo frame del video (requestVideoFrameCallback si existe). */
export function nextVideoFrame(video) {
  return new Promise((resolve) => {
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback((now, meta) => resolve(now));
    else requestAnimationFrame((now) => resolve(now));
  });
}

/** Posiciona un video en el tiempo t (segundos) y espera a que el frame este listo. */
export function seekVideo(video, t) {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
      reject(video.error ?? new Error("error al posicionar el video"));
    };
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = t;
  });
}
