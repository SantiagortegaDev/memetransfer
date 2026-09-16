// Constantes de protocolo que antes usaba el sistema de marcadores
// visuales (esquinas + tira de bits). El mecanismo de deteccion fue
// reemplazado por pHash (ver js/phash.js y js/receiver.js), pero los
// sentinelas START/END siguen usandose en el ensamblador de frames
// (ver js/frame-assembler.js) para delimitar la transmision: el receptor
// los detecta cuando el pHash del frame coincide con el pHash de
// memes/start.jpg o memes/end.jpg.

export const START = "START";
export const END = "END";

// Ya no hay SYNC_BITS, BIT_COUNT, CORNER_SIZE, etc. - todo eso era del
// sistema de marcadores. Si se llega a importar algo de aca desde afuera,
// que sea solo START/END.
