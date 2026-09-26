package me.petertian.onepku.data.repo

import android.content.Context
import android.net.Uri
import android.os.Environment
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.course.Announcement
import me.petertian.onepku.data.course.AssignmentDetail
import me.petertian.onepku.data.course.AssignmentSummary
import me.petertian.onepku.data.course.Attachment
import me.petertian.onepku.data.course.ContentItem
import me.petertian.onepku.data.course.CourseApi
import me.petertian.onepku.data.course.CourseApiException
import me.petertian.onepku.data.course.CourseInfo
import me.petertian.onepku.data.course.FeedbackAttempt
import me.petertian.onepku.data.course.LearningGrade
import me.petertian.onepku.data.course.SubmissionOutcome
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

data class AssignmentBatch(val items: List<AssignmentSummary>, val warnings: List<String>)

@Singleton
class CourseRepository @Inject constructor(
    private val api: CourseApi,
    private val auth: AuthManager,
    @ApplicationContext private val context: Context,
) {
    private val coursesCache = ScopedCache<Unit, List<CourseInfo>>({ auth.cacheScope(Service.COURSE) }, TTL)
    private val assignmentsCache = ScopedCache<String, List<AssignmentSummary>>({ auth.cacheScope(Service.COURSE) }, TTL)

    private suspend fun <T> run(block: suspend CourseApi.() -> T): T = withReauth(auth, Service.COURSE) {
        api.block()
    }

    suspend fun courses(forceRefresh: Boolean = false): List<CourseInfo> =
        coursesCache.get(Unit, forceRefresh) { run { listCourses() } }

    suspend fun announcements(courseId: String, courseName: String): List<Announcement> =
        run { listAnnouncements(courseId, courseName) }

    suspend fun content(courseId: String): List<ContentItem> = run { listAllContentRecursive(courseId) }

    suspend fun assignmentDetail(courseId: String, contentId: String): AssignmentDetail =
        run { getAssignment(courseId, contentId) }

    suspend fun attempts(courseId: String, contentId: String): List<FeedbackAttempt> =
        run { listAttempts(courseId, contentId) }

    suspend fun learningGrades(courseId: String): List<LearningGrade> = run { learningGrades(courseId) }

    /** Preserve successful courses and report failures; do not turn them into empty caches. */
    suspend fun assignments(courses: List<CourseInfo>, forceRefresh: Boolean = false): AssignmentBatch = coroutineScope {
        val expected = auth.cacheScope(Service.COURSE)
        val sem = Semaphore(3)
        val results = courses.map { course -> async {
            sem.acquire()
            try {
                val items = assignmentsCache.get(course.id, forceRefresh) { this@CourseRepository.run { listAssignmentsForCourse(course) } }
                items to null
            } catch (e: CancellationException) { throw e
            } catch (e: AccountChangedException) { throw e
            } catch (e: Exception) { emptyList<AssignmentSummary>() to "${course.name}：作业未能读取，请重试"
            } finally { sem.release() }
        }}.map { it.await() }
        if (auth.cacheScope(Service.COURSE) != expected) throw AccountChangedException()
        AssignmentBatch(results.flatMap { it.first }, results.mapNotNull { it.second })
    }

    /** 单门课的作业列表(课程详情页用)。 */
    suspend fun assignmentsForCourse(courseId: String, courseName: String): List<AssignmentSummary> =
        run { listAssignmentsForCourse(CourseInfo(courseId, courseName, true)) }

    /** 按账号和来源 URL 隔离附件，完成下载后才复用。 */
    suspend fun download(courseName: String, attachment: Attachment): File {
        val expected = auth.cacheScope(Service.COURSE)
        val dir = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            "OnePKU/${sha256(auth.accountKey(Service.COURSE).toByteArray()).take(24)}/${sanitize(courseName)}/${sha256(attachment.url.toByteArray()).take(24)}",
        )
        val dest = File(dir, sanitize(attachment.name))
        if (auth.cacheScope(Service.COURSE) != expected) throw AccountChangedException()
        if (dest.exists() && dest.length() > 0) return dest
        dir.mkdirs()
        val partial = File.createTempFile("download-", ".part", dir)
        try {
            run { downloadFile(attachment.url, partial) }
            if (auth.cacheScope(Service.COURSE) != expected) throw AccountChangedException()
            if (!partial.renameTo(dest)) throw CourseApiException("附件未能保存，请重试")
            return dest
        } finally { partial.delete() }
    }

    private fun sanitize(name: String): String =
        name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(80)

    /**
     * 提交作业:SAF 文件落到缓存 → 上传 → 重读提交记录 → 下载回执 → SHA-256 比对。
     * 写操作不自动重发:上传阶段的失败一律抛出,由用户决定是否重试。
     */
    suspend fun submitAssignment(
        courseId: String,
        contentId: String,
        source: Uri,
        displayName: String,
    ): SubmissionOutcome {
        val staged = stage(source, displayName)
        val localSha = try {
            sha256(staged)
        } catch (e: Exception) {
            staged.delete(); throw e
        }
        try {
            api.submitAssignment(courseId, contentId, staged)
        } catch (e: Exception) {
            staged.delete(); throw e
        }
        // 上传已被接受;核对失败不回滚,只如实报告。
        val snapshot = tryOrNull { run { submissionSnapshot(courseId, contentId) } }
        val receipt = snapshot?.files?.lastOrNull()
        val remote = receipt?.let { tryOrNull { run { submittedFileBytes(it.url, courseId) } } }
        staged.delete()
        if (receipt == null) {
            return SubmissionOutcome.Unverified("学校已接受提交,但未读到回执附件,请在教学网核对")
        }
        if (remote == null) {
            return SubmissionOutcome.Unverified("回执已出现(${receipt.name}),但下载核对失败")
        }
        return if (sha256(remote) == localSha) SubmissionOutcome.Confirmed(receipt.name)
        else SubmissionOutcome.Unverified("回执 ${receipt.name} 与本地校验值不一致,请人工核对")
    }

    private suspend fun <T> tryOrNull(block: suspend () -> T): T? =
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }

    private suspend fun stage(source: Uri, displayName: String): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "staged").apply { mkdirs() }
        val dest = File(dir, sanitize(displayName))
        context.contentResolver.openInputStream(source)?.use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
        } ?: throw CourseApiException("无法读取所选文件")
        if (dest.length() > MAX_SUBMIT_BYTES) {
            dest.delete()
            throw CourseApiException("文件超过 25 MB 上限")
        }
        dest
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private fun sha256(file: File): String = file.inputStream().use { sha256(it.readBytes()) }

    companion object {
        private const val TTL = 5 * 60 * 1000L
        private const val MAX_SUBMIT_BYTES = 25L * 1024 * 1024
    }
}
