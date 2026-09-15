/** Lista las camaras de video disponibles (requiere haber pedido permiso al menos una vez para tener labels). */
export async function listVideoInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

/**
 * Arranca la camara en el elemento <video> dado.
 * @param {HTMLVideoElement} videoEl
 * @param {{deviceId?: string, facingMode?: string}} options
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(videoEl, { deviceId, facingMode = "environment" } = {}) {
  const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

/** Corta todos los tracks del stream (apaga la camara). */
export function stopCamera(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}
