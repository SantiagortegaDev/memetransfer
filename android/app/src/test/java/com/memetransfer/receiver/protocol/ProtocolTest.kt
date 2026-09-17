package com.memetransfer.receiver.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * El emisor (encodeMessage) no vive en esta app receptora - se reimplementa
 * aca solo como helper de test, para poder armar tramas conocidas y
 * probar decodeFrame igual que test/protocol.test.js.
 */
private fun encodeMessageForTest(text: String): List<Int> {
    val payload = text.toByteArray(Charsets.UTF_8).map { it.toInt() and 0xFF }
    if (payload.size > MAX_PAYLOAD_BYTES) {
        throw IllegalArgumentException("too long")
    }
    return payload + crc8(payload)
}

class ProtocolTest {
    @Test
    fun `decodeFrame round-trips a message encoded by encodeMessage`() {
        val frame = encodeMessageForTest("https://x.com")
        val result = decodeFrame(frame)
        assertEquals(DecodeResult.Ok("https://x.com"), result)
    }

    @Test
    fun `decodeFrame round-trips text with accented, multibyte UTF-8 characters`() {
        val frame = encodeMessageForTest("¡Hola, ñoño! 🎉")
        val result = decodeFrame(frame)
        assertEquals(DecodeResult.Ok("¡Hola, ñoño! 🎉"), result)
    }

    @Test
    fun `decodeFrame round-trips a single-byte message`() {
        val frame = encodeMessageForTest("a")
        assertEquals(DecodeResult.Ok("a"), decodeFrame(frame))
    }

    @Test
    fun `decodeFrame rejects a frame with a corrupted payload byte`() {
        val frame = encodeMessageForTest("Hola mundo").toMutableList()
        frame[3] = frame[3] xor 0x01
        val result = decodeFrame(frame)
        assertTrue(result is DecodeResult.Error && result.error == "checksum-mismatch")
    }

    @Test
    fun `decodeFrame rejects an empty frame`() {
        val result = decodeFrame(emptyList())
        assertTrue(result is DecodeResult.Error && result.error == "frame-too-short")
    }
}
