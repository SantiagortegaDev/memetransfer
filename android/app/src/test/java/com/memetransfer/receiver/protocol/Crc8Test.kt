package com.memetransfer.receiver.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class Crc8Test {
    @Test
    fun `crc8 of empty input is 0`() {
        assertEquals(0x00, crc8(emptyList()))
    }

    @Test
    fun `crc8 matches the standard CRC-8 check value for '123456789'`() {
        val bytes = "123456789".toByteArray(Charsets.UTF_8).map { it.toInt() and 0xFF }
        assertEquals(0xf4, crc8(bytes))
    }

    @Test
    fun `crc8 of the UTF-8 bytes for 'Hello'`() {
        assertEquals(0xf6, crc8(listOf(72, 101, 108, 108, 111)))
    }

    @Test
    fun `crc8 of the UTF-8 bytes for 'Hola mundo'`() {
        assertEquals(0xb1, crc8(listOf(72, 111, 108, 97, 32, 109, 117, 110, 100, 111)))
    }

    @Test
    fun `crc8 changes when any byte flips`() {
        val original = listOf(72, 111, 108, 97, 32, 109, 117, 110, 100, 111)
        val corrupted = original.toMutableList()
        corrupted[3] = corrupted[3] xor 0x01
        assertNotEquals(crc8(original), crc8(corrupted))
    }
}
