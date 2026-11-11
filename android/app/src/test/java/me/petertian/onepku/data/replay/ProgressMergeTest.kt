package me.petertian.onepku.data.replay

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProgressMergeTest {
    private fun record(
        position: Double = 10.0,
        completed: Boolean = false,
        at: String = "2026-11-10T00:00:00Z",
        device: String = "phone",
    ) = ProgressRecord("course-1", "episode-1", position, completed, at, device)

    @Test
    fun newerPositionWinsAndCompletedSticks() {
        val merged = mergeProgress(
            record(position = 90.0, completed = true, at = "2026-11-10T00:00:00Z"),
            record(position = 15.0, completed = false, at = "2026-11-10T00:05:00Z", device = "desktop"),
        )!!
        assertEquals(15.0, merged.positionSeconds, 0.001)
        assertTrue(merged.completed)
        assertEquals("desktop", merged.deviceId)
        assertEquals("2026-11-10T00:05:00Z", merged.updatedAt)
    }

    @Test
    fun olderPositionDoesNotWin() {
        val merged = mergeProgress(
            record(position = 40.0, at = "2026-11-10T00:02:00Z"),
            record(position = 5.0, at = "2026-11-10T00:01:00Z", device = "stale"),
        )!!
        assertEquals(40.0, merged.positionSeconds, 0.001)
        assertEquals("phone", merged.deviceId)
        assertFalse(merged.completed)
    }

    @Test
    fun equalTimestampLetsIncomingWinAndNewerCompletedSticks() {
        val tie = mergeProgress(record(position = 10.0), record(position = 12.0, device = "desktop"))!!
        assertEquals(12.0, tie.positionSeconds, 0.001)
        assertEquals("desktop", tie.deviceId)
        val finished = mergeProgress(
            record(),
            record(position = 80.0, completed = true, at = "2026-11-10T00:05:00Z"),
        )!!
        assertTrue(finished.completed)
        assertEquals(80.0, finished.positionSeconds, 0.001)
    }

    @Test
    fun missingSideIsTheOtherSide() {
        val only = record()
        assertEquals(only, mergeProgress(null, only))
        assertEquals(only, mergeProgress(only, null))
        assertNull(mergeProgress(null, null))
    }

    @Test
    fun endpointNeedsHttpsAndALongToken() {
        val token = "a".repeat(32)
        assertEquals(
            "https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress",
            progressBase("https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress/", token),
        )
        assertEquals("http://127.0.0.1:8787", progressBase("http://127.0.0.1:8787", token))
        assertNull(progressBase("https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress", "short"))
        assertNull(progressBase("https://vm-0-7-ubuntu.taild19091.ts.net/onepku-progress?token=$token", token))
        assertNull(progressBase("https://user:$token@example.test/onepku-progress", token))
        assertNull(progressBase("http://example.test/onepku-progress", token))
    }

    @Test
    fun progressRecordCarriesNoCredentials() {
        val json = Json.encodeToString(ProgressRecord.serializer(), record())
        assertFalse(json.contains("password"))
        assertFalse(json.contains("secret"))
        assertFalse(json.contains("otp"))
        assertFalse(json.contains("token"))
    }
}
