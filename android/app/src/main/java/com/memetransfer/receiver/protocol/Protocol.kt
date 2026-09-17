package com.memetransfer.receiver.protocol

import java.nio.charset.StandardCharsets

// Puerto de js/protocol.js - este receptor solo necesita decodeFrame
// (encodeMessage es del lado emisor, no aplica aca).
const val MAX_PAYLOAD_BYTES = 255

sealed class DecodeResult {
    data class Ok(val text: String) : DecodeResult()
    data class Error(val error: String) : DecodeResult()
}

/**
 * Decodifica una trama completa [payload...][CRC-8] (todo lo acumulado
 * entre el marcador de inicio y el de fin).
 */
fun decodeFrame(bytes: List<Int>): DecodeResult {
    if (bytes.isEmpty()) {
        return DecodeResult.Error("frame-too-short")
    }
    val payloadBytes = bytes.subList(0, bytes.size - 1)
    val expectedCrc = bytes[bytes.size - 1]
    val actualCrc = crc8(payloadBytes)
    if (actualCrc != expectedCrc) {
        return DecodeResult.Error("checksum-mismatch")
    }
    val payloadArray = ByteArray(payloadBytes.size) { i -> payloadBytes[i].toByte() }
    return DecodeResult.Ok(String(payloadArray, StandardCharsets.UTF_8))
}
