package me.petertian.onepku.data.repo

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class TtlCacheTest {
    @Test fun logoutDoesNotDropTheLastValue() = runBlocking {
        val cache = TtlCache<String, String>(300000)
        assertEquals("grades", cache.get("grades") { "grades" })
        try {
            cache.get("grades", force = true) { throw IllegalStateException("logged out") }
            fail()
        } catch (expected: IllegalStateException) {
        }
        assertEquals("grades", cache.peek("grades"))
    }

    @Test fun failedRequestCanRetryImmediatelyWithoutEmptySuccessCache() = runBlocking {
        val cache = TtlCache<String, List<String>>(300000)
        try {
            cache.get("assignments") { throw IllegalStateException("offline") }
            fail()
        } catch (expected: IllegalStateException) {
        }
        assertNull(cache.peek("assignments"))
        assertEquals(listOf("HW1"), cache.get("assignments") { listOf("HW1") })
    }
}
