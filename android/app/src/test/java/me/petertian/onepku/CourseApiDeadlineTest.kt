package me.petertian.onepku

import me.petertian.onepku.data.course.CourseApi
import org.jsoup.Jsoup
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

/**
 * 作业到期日期的读取。教学网改版后写在 `.metaField` 里、时间拆进 `.metaSubInfo`,
 * 只找 `.itemdates` 会读成 null,于是详情页显示"截止:未知"、今日页显示"无截止时间"。
 */
class CourseApiDeadlineTest {

    private fun text(html: String): String? = CourseApi.deadlineText(Jsoup.parse(html))

    private fun epoch(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"))
        cal.clear()
        cal.set(y, mo - 1, d, h, mi)
        return cal.timeInMillis
    }

    @Test
    fun `新版页面日期与时间分在 metaField 和 metaSubInfo 里`() {
        val html = """
            <div class="metaField" aria-describedby="assignMeta2">
              2026年10月9日 星期五<span class="metaSubInfo">
                下午11:59</span>
            </div>
        """.trimIndent()
        val raw = text(html)
        assertEquals("2026年10月9日 星期五 下午11:59", raw)
        assertEquals(epoch(2026, 10, 9, 23, 59), CourseApi.parseDeadline(raw))
    }

    @Test
    fun `同一排还有满分等其他 metaField 时只取日期那个`() {
        // 日期与时间之间没有空白时,jsoup 拼出的是"星期三下午11:59",解析要照样认。
        val html = """
            <div class="metaField">满分<span class="metaSubInfo">70</span></div>
            <div class="metaField">2026年10月7日 星期三<span class="metaSubInfo">下午11:59</span></div>
        """.trimIndent()
        assertEquals(epoch(2026, 10, 7, 23, 59), CourseApi.parseDeadline(text(html)))
    }

    @Test
    fun `旧版 itemdates 仍然读得到`() {
        val html = """<span class="itemdates">2025年3月15日 星期六 下午11:59</span>"""
        val raw = text(html)
        assertEquals("2025年3月15日 星期六 下午11:59", raw)
        assertEquals(epoch(2025, 3, 15, 23, 59), CourseApi.parseDeadline(raw))
    }

    @Test
    fun `页面上没有日期就返回 null,不拿别的 metaField 顶替`() {
        assertEquals(null, text("""<div class="metaField">满分<span class="metaSubInfo">70</span></div>"""))
        assertEquals(null, text("<div>请登录</div>"))
    }

    @Test
    fun `上午12点是正午之前,下午12点是正午`() {
        assertEquals(epoch(2026, 9, 9, 0, 0), CourseApi.parseDeadline("2026年9月9日 星期三 上午12:00"))
        assertEquals(epoch(2026, 9, 9, 12, 0), CourseApi.parseDeadline("2026年9月9日 星期三 下午12:00"))
    }
}
