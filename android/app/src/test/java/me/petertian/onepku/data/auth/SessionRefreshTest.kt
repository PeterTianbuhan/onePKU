package me.petertian.onepku.data.auth

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import me.petertian.onepku.core.network.SessionExpiredException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class SessionRefreshTest {
    @Test
    fun successDoesNotRelogin() = runBlocking {
        var logins = 0
        val refresh = SessionRefresh()
        assertEquals("ok", refresh.run("course", { logins++ }) { "ok" })
        assertEquals(0, logins)
    }

    @Test
    fun otherFailuresDoNotRelogin() = runBlocking {
        var logins = 0
        val refresh = SessionRefresh()
        try {
            refresh.run("course", { logins++ }) { throw IllegalStateException("offline") }
            fail()
        } catch (expected: IllegalStateException) {
            assertEquals("offline", expected.message)
        }
        assertEquals(0, logins)
    }

    @Test
    fun retriesTheRequestOnceAfterOneRelogin() = runBlocking {
        var calls = 0
        var logins = 0
        val refresh = SessionRefresh()
        val value = refresh.run("course", { logins++ }) {
            calls++
            if (calls == 1) throw SessionExpiredException()
            "ok"
        }
        assertEquals("ok", value)
        assertEquals(1, logins)
        assertEquals(2, calls)
    }

    @Test
    fun aRetryThatIsStillExpiredDoesNotLoginAgainInTheSameCall() = runBlocking {
        var logins = 0
        val refresh = SessionRefresh(backoffMs = 60_000)
        try {
            refresh.run("course", { logins++ }) { throw SessionExpiredException() }
            fail()
        } catch (expected: SessionExpiredException) {
        }
        assertEquals(1, logins)
    }

    @Test
    fun failedReloginBacksOffUntilTheWindowPassesOrItIsCleared() = runBlocking {
        var now = 1_000L
        var logins = 0
        val refresh = SessionRefresh(nowMs = { now }, backoffMs = 60_000)
        try {
            refresh.run("course", {
                logins++
                throw IllegalStateException("nope")
            }) { throw SessionExpiredException() }
            fail()
        } catch (expected: IllegalStateException) {
            assertEquals("nope", expected.message)
        }
        assertEquals(1, logins)

        try {
            refresh.run("course", { logins++ }) { throw SessionExpiredException() }
            fail()
        } catch (expected: SessionExpiredException) {
        }
        assertEquals(1, logins)

        refresh.clear("course")
        var calls = 0
        assertEquals("ok", refresh.run("course", { logins++ }) {
            calls++
            if (calls == 1) throw SessionExpiredException()
            "ok"
        })
        assertEquals(2, logins)

        now += 60_000
        try {
            refresh.run("treehole", {
                logins++
                throw IllegalStateException("later")
            }) { throw SessionExpiredException() }
            fail()
        } catch (expected: IllegalStateException) {
        }
        try {
            refresh.run("treehole", { logins++ }) { throw SessionExpiredException() }
            fail()
        } catch (expected: SessionExpiredException) {
        }
        val afterFail = logins
        now += 60_000
        var again = 0
        assertEquals("ok", refresh.run("treehole", { logins++ }) {
            again++
            if (again == 1) throw SessionExpiredException()
            "ok"
        })
        assertEquals(afterFail + 1, logins)
    }

    @Test
    fun hungReloginTimesOutAndBacksOff() = runBlocking {
        var logins = 0
        val refresh = SessionRefresh(loginTimeoutMs = 30)
        try {
            refresh.run("course", {
                logins++
                delay(5_000)
            }) { throw SessionExpiredException() }
            fail()
        } catch (expected: SessionExpiredException) {
            assertEquals("重新登录超时", expected.message)
        }
        assertEquals(1, logins)
        try {
            refresh.run("course", { logins++ }) { throw SessionExpiredException() }
            fail()
        } catch (expected: SessionExpiredException) {
        }
        assertEquals(1, logins)
    }

    @Test
    fun concurrentExpirationsShareOneRelogin() = runBlocking {
        val refresh = SessionRefresh()
        val logins = AtomicInteger(0)
        val arrived = AtomicInteger(0)
        val release = CompletableDeferred<Unit>()
        val jobs = List(5) {
            async(Dispatchers.Default) {
                var failed = false
                refresh.run("course", {
                    logins.incrementAndGet()
                    release.await()
                }) {
                    if (!failed) {
                        failed = true
                        arrived.incrementAndGet()
                        throw SessionExpiredException()
                    }
                    "ok"
                }
            }
        }
        withTimeout(5_000) {
            while (arrived.get() < 5) delay(5)
        }
        release.complete(Unit)
        assertEquals(List(5) { "ok" }, jobs.awaitAll())
        assertEquals(1, logins.get())
    }

    @Test
    fun renewsOnlyWhenTheSessionIsExpiredOrInsideTheWindow() {
        assertFalse(sessionNeedsRenew(null, 1_000))
        assertFalse(sessionNeedsRenew(1_000 + RENEW_HORIZON_SEC + 1, 1_000))
        assertTrue(sessionNeedsRenew(1_000 + RENEW_HORIZON_SEC, 1_000))
        assertTrue(sessionNeedsRenew(1_000 - 1, 1_000))
        assertFalse(sessionNeedsRenew(2_000, 1_000, horizonSec = 60))
        assertTrue(sessionNeedsRenew(1_060, 1_000, horizonSec = 60))
    }
}
