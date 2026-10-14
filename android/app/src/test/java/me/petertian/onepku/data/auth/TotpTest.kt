package me.petertian.onepku.data.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TotpTest {
    @Test fun matchesRfc6238Sha1Vectors() {
        val secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        assertEquals("287082", Totp.generate(secret, 59))
        assertEquals("081804", Totp.generate(secret, 1111111109))
    }

    @Test fun ignoresSpacesInTheSecret() {
        assertEquals("287082", Totp.generate("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", 59))
    }
}

class ReloginGateTest {
    @Test fun failureStopsUntilManualSuccess() {
        val gate = ReloginGate()
        assertFalse(gate.isStopped("course"))
        gate.noteFailure("course")
        assertTrue(gate.isStopped("course"))
        val seen = gate.seen("course")
        gate.noteSuccess("course")
        assertFalse(gate.isStopped("course"))
        assertTrue(gate.peerRefreshed("course", seen))
    }

    @Test fun aPeerThatAlreadyRefreshedDoesNotNeedAnotherLogin() {
        val gate = ReloginGate()
        val seen = gate.seen("portal")
        gate.noteSuccess("portal")
        assertTrue(gate.peerRefreshed("portal", seen))
        assertFalse(gate.peerRefreshed("portal", gate.seen("portal")))
    }
}
