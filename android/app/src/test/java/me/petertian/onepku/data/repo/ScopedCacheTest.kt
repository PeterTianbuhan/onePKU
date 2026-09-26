package me.petertian.onepku.data.repo

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ScopedCacheTest {
    @Test fun accountSwitchAndLogoutInvalidateValues() = runBlocking {
        var account = "A"
        val cache = ScopedCache<String, String>({ account }, 300000)
        assertEquals("A grades", cache.get("grades") { "A grades" })
        account = "B"
        assertEquals("B grades", cache.get("grades") { "B grades" })
        account = "logged-out"
        try { cache.get("grades") { throw IllegalStateException("not logged in") }; fail() }
        catch (expected: IllegalStateException) { assertEquals("not logged in", expected.message) }
    }
    @Test fun staleCompletionCannotReplaceNewAccountData() = runBlocking {
        var account = "A"
        val cache = ScopedCache<String, String>({ account }, 300000)
        try { cache.get("grades") { account = "B"; "A grades" }; fail() }
        catch (expected: AccountChangedException) { }
        assertEquals("B grades", cache.get("grades") { "B grades" })
    }
    @Test fun failedRequestCanRetryImmediatelyWithoutEmptySuccessCache() = runBlocking {
        val cache = ScopedCache<String, List<String>>({ "A" }, 300000)
        try { cache.get("assignments") { throw IllegalStateException("offline") }; fail() }
        catch (expected: IllegalStateException) { }
        assertEquals(listOf("HW1"), cache.get("assignments") { listOf("HW1") })
    }
}
