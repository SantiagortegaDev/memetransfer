// Layout del emisor y parametros del localizador. Tienen que coincidir con
// training/common.py (el modelo se entrena con este mismo layout);
// test/layout-sync.test.js lo verifica.

export const FRAME_COLOR = "#FF00AA"; // FRAME_RGB = (255, 0, 170)
export const BORDER = 0.06; // grosor del marco, fraccion del lado exterior
export const OUTER_FRACTION = 0.92; // lado exterior / lado corto de la pantalla
export const GAP_GRAY = 128;

export const LOCATE_WIDTH = 320;
export const HUE_MIN = 280.0;
export const HUE_MAX = 352.0;
export const SAT_MIN = 0.35;
export const CHROMA_MIN = 40;
export const MIN_AREA_FRACTION = 0.002;
export const RING_FILL_MIN = 0.1;
export const RING_FILL_MAX = 0.45;
export const MAX_CANDIDATES = 3;
export const CENTER_CROP_FRACTION = 0.8;

export const GAP_GRID = 16;
// Gap seguro (sin preguntar al modelo) y gap cuando el modelo dice NONE.
export const GAP_RESIDUAL_MAX = 3.0;
export const GAP_RESIDUAL_NONE_MAX = 10.0;

// Aceptacion de la clase de un frame.
export const ACCEPT_P = 0.6;
export const ACCEPT_MARGIN = 0.3;
