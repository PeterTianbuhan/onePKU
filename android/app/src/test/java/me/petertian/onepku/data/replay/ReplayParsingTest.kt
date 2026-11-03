package me.petertian.onepku.data.replay

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertArrayEquals
import org.junit.Test

class ReplayParsingTest {
    private fun json(text: String) = Json.parseToJsonElement(text)

    /** 签名对不上，好学的每个接口都会拒绝；数值与桌面端的测试相同。 */
    @Test
    fun signatureMatchesTheAndroidClient() {
        val full = Haoxue.signed(
            listOf("page" to "1", "search" to "高等", "course_time" to "2026-09-30", "sub_id" to "123", "course_id" to "45"),
        )
        assertEquals("4d3e15026f6455c31153a439309cc565", full.first { it.first == "sign" }.second)
        assertEquals(2, full.count { it.first == "tenantid" || it.first == "tenantId" })
        assertEquals("4561ada4ac7e55fc43b8695d10a54f22", Haoxue.signed(emptyList()).first { it.first == "sign" }.second)
    }

    @Test
    fun loginTokenComesOutOfTheRelayPage() {
        val html = """<html><script>
          var data = {"account":"23001","_token":"abc123","_cookieToken":"ck"};
          window.bridge.PKULoginSuccess(JSON.stringify(data));
        </script></html>"""
        val found = Haoxue.parsePayload(Haoxue.extractPayload(html)!!)!!
        assertEquals("abc123", found.token)
        assertEquals("ck", found.cookieToken)
        assertEquals("23001", found.account)

        val quoted = """<div>{}</div><script>bridge.PKULoginSuccess('{"token":"t9","account":"1"}');</script>"""
        val second = Haoxue.parsePayload(Haoxue.extractPayload(quoted)!!)!!
        assertEquals("t9", second.token)
        assertEquals("t9", second.cookieToken)
        assertNull(Haoxue.extractPayload("<html><body>请登录</body></html>"))
    }

    @Test
    fun onlyPublishedReadyLessonsArePlayable() {
        assertTrue(Haoxue.state(json("""{"sub_status":"6"}""")).second)
        assertEquals("回放生成中", Haoxue.state(json("""{"sub_status":"3"}""")).first)
        assertEquals("已下架或未开放", Haoxue.state(json("""{"sub_status":"6","sub_show":"no"}""")).first)
        assertEquals("已下架或未开放", Haoxue.state(json("""{"sub_status":"6","deleted_at":"2026-09-01"}""")).first)
        val row = json("""{"sub_status":6,"sub_id":77,"sub_title":"第3讲","class_begin":"1790000000","course_id":"45","course_name":"量子力学"}""")
        val lesson = Haoxue.datedLesson(row)!!
        assertEquals("45", lesson.courseId)
        assertEquals("77", lesson.episodeId)
        assertEquals("2026-09-21 22:13", lesson.time)
    }

    @Test
    fun sourcesKeepOnlySegmentedSchoolPlaylists() {
        val mixed = json(
            """{"data":{"videoArr":[
              {"path":"https://resourcese.pku.edu.cn/v/lesson.mp4","tag":"原始"},
              {"path":"https://evil.example.com/v/lesson.m3u8","tag":"外站"},
              {"path":"https://resourcese.pku.edu.cn/v/lesson.m3u8?token=abc","tag":"标清"}]}}""",
        )
        assertEquals(listOf(Haoxue.Source("标清", "https://resourcese.pku.edu.cn/v/lesson.m3u8?token=abc")), Haoxue.sources(mixed))
        val encoded = json(
            """{"data":{"sub_content":"{\"save_playback\":{\"is_m3u8\":\"yes\",\"contents\":\"https://resourcese.pku.edu.cn/v/a.m3u8\"}}"}}""",
        )
        assertEquals("https://resourcese.pku.edu.cn/v/a.m3u8", Haoxue.sources(encoded).single().url)
        val single = json("""{"data":{"videoArr":[{"path":"https://resourcese.pku.edu.cn/v/lesson.mp4"}]}}""")
        assertTrue(runCatching { Haoxue.sources(single) }.exceptionOrNull()!!.message!!.contains("单一视频文件"))
    }

    /** 同名的别的课不能塞进这门课的回放里。 */
    @Test
    fun lessonsAreClaimedByNameWithoutGuessing() {
        fun l(name: String, id: String) = Haoxue.Lesson("1", id, "第$id 讲", "2026-10-0$id 08:00", name)
        val all = listOf(l("量子力学（A班）", "1"), l("量子力学(A班)", "2"), l("量子力学(B班)", "3"), l("热学", "4"))
        assertEquals(listOf("2", "1"), Haoxue.lessonsNamed("量子力学(A班)", all).map { it.episodeId })
        // 教学网叫「量子力学」，好学里有 A、B 两个班：分不清，宁可不显示。
        assertTrue(Haoxue.lessonsNamed("量子力学", all).isEmpty())
        assertEquals(listOf("4"), Haoxue.lessonsNamed("热学 (2026秋)", all).map { it.episodeId })
    }

    @Test
    fun playlistParsingResolvesKeysAndIvs() {
        val text = """
            #EXTM3U
            #EXT-X-VERSION:3
            #EXT-X-MEDIA-SEQUENCE:5
            #EXT-X-KEY:METHOD=AES-128,URI="key.bin"
            #EXTINF:10.0,
            seg0.ts?sign=a
            #EXT-X-DISCONTINUITY
            #EXTINF:9.5,
            seg1.ts?sign=b
            #EXT-X-KEY:METHOD=AES-128,URI="https://resourcese.pku.edu.cn/k2",IV=0x000102030405060708090a0b0c0d0e0f
            #EXTINF:4,
            /other/seg2.ts
            #EXT-X-ENDLIST
        """.trimIndent()
        val playlist = Hls.parse(text, "https://resourcese.pku.edu.cn/v/x/index.m3u8?token=t")
        assertEquals(3, playlist.segments.size)
        assertEquals("https://resourcese.pku.edu.cn/v/x/seg0.ts?sign=a", playlist.segments[0].url)
        assertEquals("https://resourcese.pku.edu.cn/v/x/key.bin", playlist.segments[0].keyUrl)
        assertArrayEquals(Hls.sequenceIv(5), playlist.segments[0].iv)
        assertArrayEquals(Hls.sequenceIv(6), playlist.segments[1].iv)
        assertTrue(playlist.segments[1].discontinuity)
        assertEquals("https://resourcese.pku.edu.cn/other/seg2.ts", playlist.segments[2].url)
        assertArrayEquals(ByteArray(16) { it.toByte() }, playlist.segments[2].iv)
        // 签名地址换了、录像没变：签名不变，已下载的分片接着用。
        val resigned = Hls.parse(text.replace("sign=a", "sign=z"), "https://resourcese.pku.edu.cn/v/x/index.m3u8?token=u")
        assertEquals(playlist.signature, resigned.signature)
        assertTrue(runCatching { Hls.parse(text.replace("#EXT-X-ENDLIST", ""), "https://resourcese.pku.edu.cn/a.m3u8") }.isFailure)
    }

    @Test
    fun localPlaylistNeverContainsSchoolAddresses() {
        val text = Hls.localPlaylist("45_77", listOf(10.0, 9.5), setOf(1))
        assertTrue(text.contains("onepku-replay://45_77/1.ts"))
        assertTrue(text.contains("#EXT-X-DISCONTINUITY\n#EXTINF:9.500,"))
        assertTrue(!text.contains("pku.edu.cn"))
    }
}
