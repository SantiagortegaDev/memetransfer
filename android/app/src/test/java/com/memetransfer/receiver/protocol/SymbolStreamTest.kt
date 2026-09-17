package com.memetransfer.receiver.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class SymbolStreamTest {
    private fun feed(stream: SymbolStream, ticks: List<Any?>): List<Any> =
        ticks.mapNotNull { stream.tick(it) }

    @Test
    fun `emits a value after stableTicksRequired consecutive matches`() {
        val stream = SymbolStream(3)
        assertEquals(listOf(7), feed(stream, listOf(7, 7, 7)))
    }

    @Test
    fun `does not emit before reaching the stability threshold`() {
        val stream = SymbolStream(3)
        assertEquals(emptyList<Any>(), feed(stream, listOf(7, 7)))
    }

    @Test
    fun `works with string sentinels like START END, not just numbers`() {
        val stream = SymbolStream(3)
        assertEquals(listOf(START), feed(stream, listOf(START, START, START)))
    }

    @Test
    fun `does not re-emit the same value while it keeps being observed without a gap`() {
        val stream = SymbolStream(3)
        assertEquals(listOf(7), feed(stream, listOf(7, 7, 7, 7, 7, 7, 7)))
    }

    @Test
    fun `re-arms after a gap and can emit the same value again`() {
        val stream = SymbolStream(3)
        assertEquals(listOf(7, 7), feed(stream, listOf(7, 7, 7, null, 7, 7, 7)))
    }

    @Test
    fun `noisy flicker between candidates does not falsely confirm either one`() {
        val stream = SymbolStream(3)
        assertEquals(emptyList<Any>(), feed(stream, listOf(1, 2, 1, 2, 1, 2)))
    }

    @Test
    fun `recovers and confirms once the flicker settles on one candidate`() {
        val stream = SymbolStream(3)
        assertEquals(listOf(3), feed(stream, listOf(1, 2, 3, 3, 3)))
    }

    @Test
    fun `transitions cleanly between a START marker and a data byte`() {
        val stream = SymbolStream(3)
        assertEquals(
            listOf(START, 42),
            feed(stream, listOf(START, START, START, null, 42, 42, 42))
        )
    }

    @Test
    fun `reset clears internal state as if freshly constructed`() {
        val stream = SymbolStream(3)
        feed(stream, listOf(7, 7, 7))
        stream.reset()
        assertEquals(listOf(7), feed(stream, listOf(7, 7, 7)))
    }
}
