package com.memetransfer.receiver.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun encodeMessageForTest(text: String): List<Int> {
    val payload = text.toByteArray(Charsets.UTF_8).map { it.toInt() and 0xFF }
    return payload + crc8(payload)
}

private fun eventsForFrame(frame: List<Int>): List<Any> =
    listOf(START) + frame + listOf(END)

class FrameAssemblerTest {
    @Test
    fun `assembles a full valid frame into the decoded text`() {
        var state = createAssemblyState()
        var done: DecodeResult? = null
        for (event in eventsForFrame(encodeMessageForTest("Hi"))) {
            val (nextState, result) = advanceAssembly(state, event)
            state = nextState
            if (result != null) done = result
        }
        assertEquals(DecodeResult.Ok("Hi"), done)
        assertEquals(createAssemblyState(), state)
    }

    @Test
    fun `ignores data bytes observed before the START marker`() {
        var state = createAssemblyState()
        state = advanceAssembly(state, 55).first
        state = advanceAssembly(state, 3).first
        assertEquals(createAssemblyState(), state)
    }

    @Test
    fun `ignores an END marker observed before any START`() {
        val state = createAssemblyState()
        val (next, done) = advanceAssembly(state, END)
        assertEquals(createAssemblyState(), next)
        assertNull(done)
    }

    @Test
    fun `START resets accumulation even mid-transmission (a resend always wins)`() {
        var state = createAssemblyState()
        state = advanceAssembly(state, START).first
        state = advanceAssembly(state, 1).first
        state = advanceAssembly(state, 2).first
        state = advanceAssembly(state, START).first // arranca de nuevo
        assertEquals(AssemblyState(receiving = true, buffer = emptyList()), state)
    }

    @Test
    fun `reports a checksum-mismatch error for a corrupted frame and resets state`() {
        val frame = encodeMessageForTest("Hi").toMutableList()
        frame[0] = frame[0] xor 0xff
        var state = createAssemblyState()
        var done: DecodeResult? = null
        for (event in eventsForFrame(frame)) {
            val (nextState, result) = advanceAssembly(state, event)
            state = nextState
            if (result != null) done = result
        }
        assertTrue(done is DecodeResult.Error && (done as DecodeResult.Error).error == "checksum-mismatch")
        assertEquals(createAssemblyState(), state)
    }

    @Test
    fun `can assemble a second message right after the first completes`() {
        var state = createAssemblyState()
        for (event in eventsForFrame(encodeMessageForTest("Hi"))) {
            state = advanceAssembly(state, event).first
        }
        var done: DecodeResult? = null
        for (event in eventsForFrame(encodeMessageForTest("Chau"))) {
            val (nextState, result) = advanceAssembly(state, event)
            state = nextState
            if (result != null) done = result
        }
        assertEquals(DecodeResult.Ok("Chau"), done)
    }
}
