package com.memetransfer.receiver.protocol

// CRC-8 estandar (poly 0x07, init 0x00, sin reflejar). Puerto directo de
// js/crc8.js - se usa para verificar que la secuencia de memes recibida
// coincide byte a byte con la enviada.
private const val POLY = 0x07

fun crc8(bytes: List<Int>): Int {
    var crc = 0x00
    for (byte in bytes) {
        crc = crc xor (byte and 0xFF)
        repeat(8) {
            crc = if (crc and 0x80 != 0) {
                (crc shl 1) xor POLY
            } else {
                crc shl 1
            }
            crc = crc and 0xFF
        }
    }
    return crc
}
