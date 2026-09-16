// Sentinelas de inicio/fin de transmision, compartidos entre el motor de
// reconocimiento (js/vision.js, que los produce al matchear las imagenes de
// control) y el ensamblador de tramas (js/frame-assembler.js, que los
// consume). Viven en su propio modulo para no atar frame-assembler.js a la
// implementacion concreta del reconocimiento.
export const START = "START";
export const END = "END";
