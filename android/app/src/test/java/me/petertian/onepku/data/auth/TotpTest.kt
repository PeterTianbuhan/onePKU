package me.petertian.onepku.data.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RFC 6238 附录 B 的 SHA1 密钥 "12345678901234567890"，取 6 位。 */
private const val RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

class TotpTest {
    @Test
    fun matchesRfc6238Sha1Vectors() {
        assertEquals("287082", Totp.generate(RFC_SECRET, 59))
        assertEquals("081804", Totp.generate(RFC_SECRET, 1_111_111_109))
        assertEquals("050471", Totp.generate(RFC_SECRET, 1_111_111_111))
        assertEquals("005924", Totp.generate(RFC_SECRET, 1_234_567_890))
        assertEquals("279037", Totp.generate(RFC_SECRET, 2_000_000_000))
        assertEquals("353130", Totp.generate(RFC_SECRET, 20_000_000_000))
    }

    @Test
    fun sameStepGivesTheSameCode() {
        assertEquals(Totp.generate(RFC_SECRET, 30), Totp.generate(RFC_SECRET, 59))
        assertEquals(Totp.generate(RFC_SECRET, 0), Totp.generate(RFC_SECRET, 29))
    }

    @Test
    fun ignoresCaseWhitespaceAndPadding() {
        assertEquals("287082", Totp.generate("  gezd gnbvgy3tqojqgezdgnbvgy3tqojq  ", 59))
        assertEquals("287082", Totp.generate("$RFC_SECRET====", 59))
    }

    @Test
    fun parsesOtpAuthUriAndBareSecret() {
        val uri = "otpauth://totp/iaaa.pku.edu.cn:0000000000?secret=gezd%20gnbvgy3tqojqgezdgnbvgy3tqojq&issuer=iaaa.pku.edu.cn&algorithm=SHA1&digits=6&period=30"
        assertEquals(RFC_SECRET, Totp.parseSecret(uri))
        assertEquals("287082", Totp.generate(Totp.parseSecret(uri)!!, 59))
        assertEquals(RFC_SECRET, Totp.parseSecret(" $RFC_SECRET "))
        assertEquals("287082", Totp.current(RFC_SECRET, 59_000))
    }

    @Test
    fun rejectsOtherAlgorithmsPeriodsAndGarbage() {
        val secret = "secret=$RFC_SECRET"
        assertNull(Totp.parseSecret("otpauth://hotp/iaaa?$secret"))
        assertNull(Totp.parseSecret("otpauth://totp/iaaa?$secret&algorithm=SHA256"))
        assertNull(Totp.parseSecret("otpauth://totp/iaaa?$secret&digits=8"))
        assertNull(Totp.parseSecret("otpauth://totp/iaaa?$secret&period=60"))
        assertNull(Totp.parseSecret("otpauth://totp/iaaa?issuer=iaaa.pku.edu.cn"))
        assertNull(Totp.parseSecret("not-a-secret!"))
        assertNull(Totp.parseSecret("0000000000000000"))
        assertNull(Totp.parseSecret("   "))
        assertNull(Totp.parseSecret(""))
    }

    @Test
    fun sha1SpellingIsCaseInsensitive() {
        assertEquals(RFC_SECRET, Totp.parseSecret("otpauth://totp/iaaa?secret=$RFC_SECRET&algorithm=sha1"))
    }
}
