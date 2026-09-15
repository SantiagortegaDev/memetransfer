// CRC-8 estandar (poly 0x07, init 0x00, sin reflejar). Se usa para verificar
// que la secuencia de memes recibida coincide byte a byte con la enviada.
const POLY = 0x07;

export function crc8(bytes) {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ POLY) & 0xFF : (crc << 1) & 0xFF;
    }
  }
  return crc;
}
