package me.petertian.onepku

import me.petertian.onepku.data.course.CourseApi
import me.petertian.onepku.data.course.CourseApiException
import org.jsoup.Jsoup
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 提交记录页的回执解析。真机上出现过"学校显示提交成功、应用却报下载核对失败":
 * 一行里文件名与下载是两个 a,只取 a.attachment 的 href 拿不到可下载的地址。
 */
class CourseApiSubmissionTest {

    private val pageUrl = CourseApi.assignmentUrl("_1_1", "_2_1")

    /** 与 CourseApi.getDoc 一致:用页面地址做 base,相对链接才解析得对。 */
    private fun parse(html: String) = CourseApi.parseSubmission(Jsoup.parse(html, pageUrl))

    private fun page(vararg rows: String) = """
        <h3 id="currentAttempt_label">尝试 1</h3>
        <ul id="currentAttempt_submissionList">${rows.joinToString("") { "<li>$it</li>" }}</ul>
    """.trimIndent()

    @Test
    fun `文件名与下载是两个链接时取下载地址`() {
        val snapshot = parse(
            page(
                """<a class="attachment" href="/webapps/assignment/preview?file_id=_9_1">作业.pdf</a>
                   <a class="dwnldBtn" href="/webapps/assignment/download?course_id=_1_1&file_id=_9_1">下载</a>""",
            ),
        )
        assertEquals("尝试 1", snapshot.label)
        assertTrue(snapshot.submitted)
        assertEquals("作业.pdf", snapshot.files.single().name)
        assertEquals(
            "https://course.pku.edu.cn/webapps/assignment/download?course_id=_1_1&file_id=_9_1",
            snapshot.files.single().url,
        )
    }

    @Test
    fun `相对下载链接按作业页地址解析`() {
        val snapshot = parse(
            page(
                """<a class="attachment" href="#">作业.pdf</a>
                   <a class="dwnldBtn" href="download?course_id=_1_1&file_id=_9_1">下载</a>""",
            ),
        )
        assertEquals(
            "https://course.pku.edu.cn/webapps/assignment/download?course_id=_1_1&file_id=_9_1",
            snapshot.files.single().url,
        )
    }

    @Test
    fun `没有下载按钮时回退到文件名链接`() {
        val snapshot = parse(
            page("""<a class="attachment" href="/webapps/assignment/preview?file_id=_9_1">作业.pdf</a>"""),
        )
        assertEquals("作业.pdf", snapshot.files.single().name)
        assertEquals(
            "https://course.pku.edu.cn/webapps/assignment/preview?file_id=_9_1",
            snapshot.files.single().url,
        )
    }

    @Test
    fun `多个附件按页面顺序全部保留`() {
        val snapshot = parse(
            page(
                """<a class="attachment" href="/webapps/assignment/download?course_id=_1_1&file_id=_9_1">a.pdf</a>""",
                """<a class="attachment" href="/webapps/assignment/download?course_id=_1_1&file_id=_8_1">b.pdf</a>""",
            ),
        )
        assertEquals(listOf("a.pdf", "b.pdf"), snapshot.files.map { it.name })
    }

    @Test
    fun `尝试行的紧凑时间算作提交时刻`() {
        // 真机页面:右侧"作业详细信息"里 尝试 / 26-9-28 下午10:22 / 提交 / PDF_20260928_222149.pdf
        val snapshot = parse(
            """
            <div id="currentAttempt">
              <h3 id="currentAttempt_label">尝试</h3>
              <span>26-9-28 下午10:22</span>
              <span>/100</span>
              <ul id="currentAttempt_submissionList">
                <li><a class="attachment" href="/webapps/assignment/download?course_id=_1_1&amp;file_id=_9_1&amp;fileName=PDF_20260928_222149.pdf">PDF_20260928_222149.pdf</a>
                    <a class="dwnldBtn" href="/webapps/assignment/download?course_id=_1_1&amp;file_id=_9_1&amp;action=download">下载</a></li>
              </ul>
            </div>
            """.trimIndent(),
        )
        val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Shanghai"))
        cal.clear()
        cal.set(2026, java.util.Calendar.SEPTEMBER, 28, 22, 22)
        assertEquals(cal.timeInMillis, snapshot.submittedAtEpochMs)
        assertEquals(
            "https://course.pku.edu.cn/webapps/assignment/download?course_id=_1_1&file_id=_9_1&action=download",
            snapshot.files.single().url,
        )
    }

    @Test
    fun `页面没给紧凑时间就不臆造提交时刻`() {
        assertEquals(null, parse(page("""<a class="attachment" href="/webapps/assignment/download?course_id=_1_1">a.pdf</a>""")).submittedAtEpochMs)
    }

    @Test
    fun `认不出的页面抛异常而不是当成没有回执`() {
        val e = assertThrows(CourseApiException::class.java) { parse("<html><body>请登录</body></html>") }
        assertEquals("无法识别提交记录页面", e.message)
    }
}
