package me.petertian.onepku.data.course

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import me.petertian.onepku.core.network.CookieStores
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.core.session.Service
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.io.File
import java.util.Calendar
import java.util.TimeZone
import javax.inject.Inject

/** 教学网 (Blackboard) 数据访问:几乎全部为 HTML,Jsoup 解析。 */
class CourseApi @Inject constructor(
    private val httpFactory: HttpFactory,
    private val cookieStores: CookieStores,
) {

    private fun client(): OkHttpClient =
        httpFactory.client(cookieJar = cookieStores.jar(Service.COURSE.key), ua = Ua.DESKTOP)

    private fun checkSession(resp: Response, body: String) {
        val url = resp.request.url
        if (url.host == "iaaa.pku.edu.cn" || url.encodedPath.contains("login")) {
            throw SessionExpiredException()
        }
        if (body.contains("name=\"loginForm\"") || body.contains("id=\"loginBox\"")) {
            throw SessionExpiredException()
        }
    }

    private suspend fun get(url: String): String = withContext(Dispatchers.IO) {
        client().newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (resp.code == 401) throw SessionExpiredException()
            if (!resp.isSuccessful) throw CourseApiException("请求失败: HTTP ${resp.code}")
            val body = resp.requireBody().string()
            checkSession(resp, body)
            body
        }
    }

    private suspend fun getDoc(url: String): Document = Jsoup.parse(get(url), COURSE_BASE)

    // ---- 课程列表 ----

    suspend fun listCourses(): List<CourseInfo> = coroutineScope {
        val doc = getDoc("$COURSE_BASE/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1")
        val keyRe = Regex("key=([\\d_]+),")
        val courses = mutableListOf<CourseInfo>()
        for (portlet in doc.select("div.portlet")) {
            val titleText = portlet.select("span.moduleTitle").first()?.text() ?: ""
            val isCurrent = titleText.contains("当前") || titleText.contains("Current Semester")
            for (ul in portlet.select("ul.courseListing")) {
                for (a in ul.select("li a")) {
                    val href = a.attr("href")
                    val key = keyRe.find(href)?.groupValues?.get(1) ?: continue
                    courses.add(CourseInfo(id = key, longTitle = a.text().trim(), isCurrent = isCurrent))
                }
            }
        }
        courses
    }

    // ---- 课程主页 / 侧边栏 ----

    private fun coursePageUrl(courseId: String) =
        "$COURSE_BASE/webapps/blackboard/execute/announcement?method=search&context=course_entry" +
            "&course_id=$courseId&handle=announcements_entry&mode=view"

    suspend fun listCourseEntries(courseId: String): List<CourseEntry> {
        val doc = getDoc(coursePageUrl(courseId))
        return doc.select("#courseMenuPalette_contents > li > a").mapNotNull { a ->
            val name = a.text().trim()
            val href = a.attr("href")
            if (name.isEmpty() || href.isEmpty()) null else CourseEntry(name, href)
        }
    }

    // ---- 内容(资料/作业/文件夹)----

    suspend fun listContent(courseId: String, contentId: String): List<ContentItem> {
        val doc = getDoc(
            "$COURSE_BASE/webapps/blackboard/content/listContent.jsp?content_id=$contentId&course_id=$courseId"
        )
        return parseContentItems(doc)
    }

    private fun parseContentItems(doc: Document): List<ContentItem> {
        val items = mutableListOf<ContentItem>()
        for (li in doc.select("#content_listContainer > li, li.clearfix")) {
            val title = li.select("h3").first()?.text()?.trim().orEmpty()
            if (title.isEmpty()) continue

            val link = li.select("h3 a").first()
            val url = link?.absUrl("href")?.ifEmpty { null }
            val id = li.attr("id").removePrefix("contentListItem").removePrefix(":")
                .ifEmpty {
                    url?.let { parseContentId(it) } ?: ""
                }

            val description = (li.select("div.vtbegenerated").first() ?: li.select("div.details").first())
                ?.text()?.trim().orEmpty()

            val attachments = li.select("ul.attachments li a").mapNotNull { a ->
                val name = a.text().replace(' ', ' ').trim()
                val href = a.absUrl("href")
                if (name.isEmpty() || href.isEmpty()) null else Attachment(name, href)
            }.toMutableList()

            val imgAlt = li.select("img").first()?.attr("alt").orEmpty()
            val type = when {
                imgAlt == "作业" || url?.contains("uploadAssignment") == true || url?.contains("assignment") == true ->
                    ContentType.ASSIGNMENT
                url?.contains("listContent") == true -> ContentType.FOLDER
                else -> ContentType.DOCUMENT
            }

            if (type == ContentType.DOCUMENT && url != null && url.contains("/bbcswebdav/")) {
                if (attachments.none { it.url == url }) attachments.add(Attachment(title, url))
            }

            items.add(
                ContentItem(
                    id = id,
                    title = title,
                    type = type,
                    url = url,
                    attachments = attachments,
                    description = description,
                    hasLink = link != null,
                )
            )
        }
        return items
    }

    /** 从侧边栏入口出发 BFS 递归收集全部内容。 */
    suspend fun listAllContentRecursive(courseId: String): List<ContentItem> = coroutineScope {
        val entries = listCourseEntries(courseId)
        val visited = mutableSetOf<String>()
        val queue = ArrayDeque<String>()
        for (entry in entries) {
            parseContentId(entry.url)?.let { cid ->
                if (visited.add(cid)) queue.add(cid)
            }
        }
        val all = mutableListOf<ContentItem>()
        val sem = Semaphore(4)
        while (queue.isNotEmpty()) {
            val batch = mutableListOf<String>()
            repeat(minOf(4, queue.size)) { batch.add(queue.removeFirst()) }
            val results = batch.map { cid ->
                async(Dispatchers.IO) { sem.withPermit { listContent(courseId, cid) } }
            }.map { it.await() }
            for (items in results) {
                for (item in items) {
                    if (item.type == ContentType.FOLDER && item.hasLink) {
                        item.url?.let { parseContentId(it) }?.let { cid ->
                            if (visited.add(cid)) queue.add(cid)
                        }
                    }
                    all.add(item)
                }
            }
        }
        all
    }

    private fun parseContentId(url: String): String? = runCatching {
        val abs = if (url.startsWith("http")) url else "$COURSE_BASE$url"
        abs.toHttpUrl().queryParameter("content_id")
    }.getOrNull()

    // ---- 公告 ----

    suspend fun listAnnouncements(courseId: String, courseName: String = ""): List<Announcement> {
        val doc = getDoc(coursePageUrl(courseId))
        return doc.select("#announcementList > li").mapNotNull { li ->
            val id = li.attr("id")
            val title = li.select("h3").first()?.text()?.trim().orEmpty()
            if (title.isEmpty()) return@mapNotNull null
            val bodyHtml = li.select(".vtbegenerated").first()?.html().orEmpty()
            val details = li.select(".details").first()?.text().orEmpty()
            val date = details.substringAfter("发布时间:").substringBefore(" ").trim()
                .ifEmpty { details.trim() }
            val author = li.select(".announcementInfo").first()?.text()
                ?.substringAfter("发帖者:")?.trim().orEmpty()
            Announcement(id, courseId, courseName, title, bodyHtml, date, author)
        }
    }

    // ---- 作业 ----

    private fun parseAssignment(doc: Document): AssignmentDetail {
        val title = (doc.select("span.title").first() ?: doc.select("#pageTitleText").first())
            ?.text()?.trim().orEmpty()
        val deadlineRaw = doc.select(".itemdates").first()?.text()?.trim()
        val instructions = doc.select("div.vtbegenerated").first()?.text()?.trim().orEmpty()
        val attachments = doc.select("ul.attachments li a").mapNotNull { a ->
            val name = a.text().trim()
            val href = a.absUrl("href")
            if (name.isEmpty() || href.isEmpty() || href.startsWith("javascript:") || href == "#") null
            else Attachment(name, href)
        }
        val status = doc.select(".status").first()?.text()?.trim() ?: "未知"
        return AssignmentDetail(title, deadlineRaw, parseDeadline(deadlineRaw), instructions, attachments, status)
    }

    suspend fun getAssignment(courseId: String, contentId: String): AssignmentDetail =
        parseAssignment(getDoc(assignmentUrl(courseId, contentId)))

    /** 一次抓取同时取到作业说明与当前提交情况。 */
    suspend fun assignmentOverview(courseId: String, contentId: String): Pair<AssignmentDetail, SubmissionSnapshot> {
        val doc = getDoc(assignmentUrl(courseId, contentId))
        return parseAssignment(doc) to runCatching { parseSubmission(doc) }.getOrDefault(SubmissionSnapshot(null, emptyList()))
    }

    /** 汇总一门课的全部作业(递归发现 + 逐个详情)。 */
    suspend fun listAssignmentsForCourse(course: CourseInfo): List<AssignmentSummary> = coroutineScope {
        val content = listAllContentRecursive(course.id)
        val assignments = content.filter { it.type == ContentType.ASSIGNMENT && it.id.isNotEmpty() }
        // 成绩中心按标题匹配,提供提交与评分的第二个来源;读不到不影响作业列表。
        val gradeCenter = runCatching { learningGrades(course.id) }.getOrNull().orEmpty()
            .associateBy { it.title.trim() }
        val sem = Semaphore(3)
        assignments.map { item ->
            async(Dispatchers.IO) {
                sem.withPermit {
                    runCatching { assignmentOverview(course.id, item.id) }.getOrNull()?.let { (detail, submission) ->
                        val title = detail.title.ifEmpty { item.title }
                        val grade = gradeCenter[title.trim()]
                        val graded = grade?.score?.trim()?.takeUnless { it.isEmpty() || it == "-" || it == "—" }
                        AssignmentSummary(
                            courseId = course.id,
                            courseName = course.name,
                            contentId = item.id,
                            title = title,
                            deadlineRaw = detail.deadlineRaw,
                            deadlineEpochMs = detail.deadlineEpochMs,
                            status = detail.status,
                            submitted = submission.submitted ||
                                grade?.status?.contains("已提交") == true || graded != null,
                            scoreText = graded,
                        )
                    }
                }
            }
        }.mapNotNull { it.await() }
    }

    // ---- 作业反馈 / 提交历史 ----

    suspend fun listAttempts(courseId: String, contentId: String): List<FeedbackAttempt> = coroutineScope {
        val base = assignmentUrl(courseId, contentId)
        val doc = getDoc(base)
        val currentLabel = doc.select("h3#currentAttempt_label").first()?.text()
            ?.replace(Regex("\\s+"), " ")?.trim()?.ifEmpty { null }
        val currentId = doc.select(
            "#currentAttempt_attemptList li.current a[href], #currentAttempt_attemptList a.current[href]",
        ).firstOrNull()?.absUrl("href")
            ?.let { runCatching { it.toHttpUrl().queryParameter("attempt_id") }.getOrNull() }

        // 只提交过一次时学校不渲染历史链接,当前尝试就在本页面上。
        val current = currentLabel?.let { label ->
            runCatching { parseAttemptPage(doc, currentId ?: "current:$label", label, base) }.getOrNull()
        }
        val links = doc.select("#currentAttempt_attemptList a[href]")
            .mapNotNull { a ->
                val href = a.absUrl("href")
                val id = runCatching { href.toHttpUrl().queryParameter("attempt_id") }.getOrNull()
                if (id.isNullOrEmpty()) null else id to a.text().trim()
            }
            .distinctBy { it.first }
            .filter { it.first != currentId }

        val sem = Semaphore(3)
        val history = links.map { (id, label) ->
            async(Dispatchers.IO) {
                sem.withPermit {
                    val url = "$base&attempt_id=$id"
                    runCatching { parseAttemptPage(getDoc(url), id, label, url) }.getOrNull()
                }
            }
        }.mapNotNull { it.await() }

        (listOfNotNull(current) + history).distinctBy { it.id }
    }

    private fun parseAttemptPage(doc: Document, id: String, label: String, url: String): FeedbackAttempt {
        fun text(sel: String): String? = doc.select(sel).first()?.text()
            ?.replace(Regex("\\s+"), " ")?.trim()?.ifEmpty { null }

        // 分数在 <input id="currentAttempt_grade" value="..."> 上,取属性而非文本。
        val gradeEl = doc.select("#currentAttempt_grade").first()
        val score = (gradeEl?.attr("value")?.ifBlank { null } ?: text("#currentAttempt_grade"))
            ?.trim()?.takeUnless { it == "-" || it == "—" || it.isEmpty() }
        val points = text("#currentAttempt_pointsPossible")?.removePrefix("/")?.trim()
        val feedback = doc.select("#currentAttempt_feedback .vtbegenerated").first()?.text()?.trim()
        val files = doc.select("#currentAttempt_submissionList a.attachment[href]").mapNotNull { a ->
            val name = a.text().trim()
            val href = a.absUrl("href")
            if (name.isEmpty() || href.isEmpty()) null else Attachment(name, href)
        }
        return FeedbackAttempt(id, label, score, points, feedback, files, url)
    }

    // ---- 教学网成绩 ----

    suspend fun learningGrades(courseId: String): List<LearningGrade> {
        val entry = listCourseEntries(courseId)
            .firstOrNull { it.name in listOf("个人成绩", "我的成绩", "My Grades") }
            ?: throw CourseApiException("本课程未开放个人成绩入口")
        val url = if (entry.url.startsWith("http")) entry.url else "$COURSE_BASE${entry.url}"
        val doc = getDoc(url)
        if (doc.select("#grades_wrapper").isEmpty()) {
            throw CourseApiException("未识别教学网成绩页面")
        }
        return doc.select("#grades_wrapper .sortable_item_row[role='row']").mapNotNull { row ->
            fun text(sel: String): String = row.select(sel).first()?.text()
                ?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
            val id = row.attr("id").ifEmpty { return@mapNotNull null }
            val title = text(".gradable > a, .gradable > span")
            if (title.isEmpty()) return@mapNotNull null
            LearningGrade(
                id = id,
                title = title,
                category = text(".itemCat"),
                score = text(".cell.grade"),
                activity = text(".activityType"),
                updated = text(".lastActivityDate"),
                status = text(".gradeStatus"),
            )
        }
    }

    // ---- 作业提交(写操作;仅在用户明确确认后由 Repository 调用) ----

    /** 读取当前提交记录(不创建尝试)。 */
    suspend fun submissionSnapshot(courseId: String, contentId: String): SubmissionSnapshot =
        parseSubmission(getDoc(assignmentUrl(courseId, contentId)))

    private fun parseSubmission(doc: Document): SubmissionSnapshot {
        val label = doc.select("h3#currentAttempt_label").first()?.text()
            ?.replace(Regex("\\s+"), " ")?.trim()?.ifEmpty { null }
        val recognized = label != null ||
            doc.select("#uploadAssignmentFormId, #pageTitleText, span.title").isNotEmpty()
        if (!recognized) throw CourseApiException("无法识别提交记录页面")
        val files = doc.select("#currentAttempt_submissionList a.attachment[href]").mapNotNull { a ->
            val name = a.text().trim().ifEmpty { return@mapNotNull null }
            val href = a.absUrl("href").ifEmpty { return@mapNotNull null }
            Attachment(name, href)
        }
        return SubmissionSnapshot(label, files)
    }

    /** 新尝试表单的隐藏字段。 */
    private suspend fun submitFormFields(courseId: String, contentId: String): Map<String, String> {
        val url = "$COURSE_BASE/webapps/assignment/uploadAssignment" +
            "?action=newAttempt&content_id=$contentId&course_id=$courseId"
        val doc = getDoc(url)
        val fields = buildMap {
            (doc.select("form#uploadAssignmentFormId input") + doc.select("div.field input"))
                .forEach { input ->
                    val name = input.attr("name").ifEmpty { return@forEach }
                    if (!containsKey(name)) put(name, input.attr("value"))
                }
        }
        if (fields["course_id"] != courseId || fields["content_id"] != contentId) {
            throw CourseApiException("提交表单目标不匹配")
        }
        return fields
    }

    /** 上传单个文件作为一次新提交。成功仅代表学校接受请求,回执需另行核对。 */
    suspend fun submitAssignment(courseId: String, contentId: String, file: File) =
        withContext(Dispatchers.IO) {
            val fields = submitFormFields(courseId, contentId)
            fun f(name: String): String =
                fields[name] ?: throw CourseApiException("提交表单字段 '$name' 未找到")

            val filename = file.name
            val multipart = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
                listOf(
                    "attempt_id",
                    "blackboard.platform.security.NonceUtil.nonce",
                    "blackboard.platform.security.NonceUtil.nonce.ajax",
                    "content_id", "course_id", "isAjaxSubmit", "lu_link_id", "mode",
                    "recallUrl", "remove_file_id",
                    "studentSubmission.text_f", "studentSubmission.text_w", "studentSubmission.type",
                    "student_commentstext_f", "student_commentstext_w", "student_commentstype",
                    "textbox_prefix",
                ).forEach { addFormDataPart(it, f(it)) }
                addFormDataPart("studentSubmission.text", "")
                addFormDataPart("student_commentstext", "")
                addFormDataPart("dispatch", "submit")
                addFormDataPart("newFile_artifactFileId", "undefined")
                addFormDataPart("newFile_artifactType", "undefined")
                addFormDataPart("newFile_artifactTypeResourceKey", "undefined")
                addFormDataPart("newFile_attachmentType", "L")
                addFormDataPart("newFile_fileId", "new")
                addFormDataPart("newFile_linkTitle", filename)
                addFormDataPart("newFilefilePickerLastInput", "dummyValue")
                addFormDataPart(
                    "newFile_LocalFile0", filename,
                    file.asRequestBody(mimeTypeOf(filename).toMediaTypeOrNull()),
                )
                addFormDataPart("useless", "")
            }.build()

            val uploadClient = httpFactory.client(
                cookieJar = cookieStores.jar(Service.COURSE.key),
                followRedirects = false,
                ua = Ua.DESKTOP,
                readTimeoutSec = 45,
            )
            val request = Request.Builder()
                .url("$COURSE_BASE/webapps/assignment/uploadAssignment?action=submit")
                .header("origin", COURSE_BASE)
                .header("accept", "*/*")
                .post(multipart)
                .build()
            uploadClient.newCall(request).execute().use { resp ->
                val reqUrl = resp.request.url
                if (reqUrl.host == "iaaa.pku.edu.cn" || reqUrl.encodedPath.contains("login")) {
                    throw SessionExpiredException()
                }
                if (!resp.isSuccessful && !resp.isRedirect) {
                    throw CourseApiException("提交响应未确认: HTTP ${resp.code}")
                }
            }
        }

    /** 下载回执附件用于 SHA-256 核对,上限 25MB。 */
    suspend fun submittedFileBytes(raw: String, courseId: String): ByteArray = withContext(Dispatchers.IO) {
        val u = runCatching { raw.toHttpUrl() }.getOrElse { throw CourseApiException("提交附件链接无效") }
        if (u.scheme != "https" || u.host != "course.pku.edu.cn" ||
            u.encodedPath != "/webapps/assignment/download" ||
            u.queryParameter("course_id") != courseId
        ) {
            throw CourseApiException("提交附件链接无效")
        }
        client().newCall(Request.Builder().url(u).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw CourseApiException("回执下载失败: HTTP ${resp.code}")
            val reqUrl = resp.request.url
            if (reqUrl.host != "course.pku.edu.cn" || reqUrl.encodedPath.contains("login")) {
                throw SessionExpiredException()
            }
            val bytes = resp.requireBody().byteStream().use { it.readBytes() }
            if (bytes.size > 25 * 1024 * 1024) throw CourseApiException("提交附件超出核对上限")
            bytes
        }
    }

    // ---- 下载 ----

    suspend fun downloadFile(url: String, dest: File): File = withContext(Dispatchers.IO) {
        client().newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw CourseApiException("下载失败: HTTP ${resp.code}")
            dest.parentFile?.mkdirs()
            resp.requireBody().byteStream().use { input ->
                dest.outputStream().use { output -> input.copyTo(output) }
            }
            dest
        }
    }

    companion object {
        const val COURSE_BASE = "https://course.pku.edu.cn"

        fun assignmentUrl(courseId: String, contentId: String) =
            "$COURSE_BASE/webapps/assignment/uploadAssignment?mode=view&content_id=$contentId&course_id=$courseId"

        private val MIME = mapOf(
            "pdf" to "application/pdf",
            "doc" to "application/msword",
            "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls" to "application/vnd.ms-excel",
            "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt" to "application/vnd.ms-powerpoint",
            "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "zip" to "application/zip",
            "rar" to "application/vnd.rar",
            "7z" to "application/x-7z-compressed",
            "txt" to "text/plain",
            "md" to "text/markdown",
            "csv" to "text/csv",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "mp4" to "video/mp4",
            "mp3" to "audio/mpeg",
            "py" to "text/x-python",
            "ipynb" to "application/x-ipynb+json",
            "java" to "text/x-java-source",
            "c" to "text/x-c",
            "cpp" to "text/x-c++src",
            "tex" to "application/x-tex",
            "html" to "text/html",
        )

        fun mimeTypeOf(filename: String): String =
            MIME[filename.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

        /** 解析 Blackboard 中文截止时间 "2025年3月15日 星期六 下午11:59" → epoch millis(UTC+8)。 */
        fun parseDeadline(raw: String?): Long? {
            if (raw == null) return null
            val m = Regex("(\\d{4})年(\\d{1,2})月(\\d{1,2})日\\s*星期.\\s*(上午|下午)(\\d{1,2}):(\\d{1,2})")
                .find(raw) ?: return null
            val (year, month, day, ampm, hourStr, minuteStr) = m.destructured
            var hour = hourStr.toInt()
            if (ampm == "下午" && hour < 12) hour += 12
            if (ampm == "上午" && hour == 12) hour = 0
            val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"))
            cal.clear()
            cal.set(year.toInt(), month.toInt() - 1, day.toInt(), hour, minuteStr.toInt())
            return cal.timeInMillis
        }
    }
}

class CourseApiException(message: String) : Exception(message)
