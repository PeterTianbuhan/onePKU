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
import me.petertian.onepku.data.course.SubmissionSnapshot
import java.io.File
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CourseRepository @Inject constructor(
    private val api: CourseApi,
    private val auth: AuthManager,
    @ApplicationContext private val context: Context,
) {
    private var coursesCache: CacheEntry<List<CourseInfo>>? = null
    private val assignmentsCache = mutableMapOf<String, CacheEntry<List<AssignmentSummary>>>()

    private suspend fun <T> run(block: suspend CourseApi.() -> T): T = withReauth(auth, Service.COURSE) {
        api.block()
    }

    suspend fun courses(forceRefresh: Boolean = false): List<CourseInfo> {
        coursesCache?.takeIf { !forceRefresh && it.fresh(TTL) }?.let { return it.data }
        return run { listCourses() }.also { coursesCache = CacheEntry(it) }
    }

    suspend fun announcements(courseId: String, courseName: String): List<Announcement> =
        run { listAnnouncements(courseId, courseName) }

    suspend fun content(courseId: String): List<ContentItem> = run { listAllContentRecursive(courseId) }

    /** 一次抓取同时拿到作业详情与当前尝试的提交快照。 */
    suspend fun assignmentOverview(courseId: String, contentId: String): Pair<AssignmentDetail, SubmissionSnapshot> =
        run { assignmentOverview(courseId, contentId) }

    suspend fun attempts(courseId: String, contentId: String): List<FeedbackAttempt> =
        run { listAttempts(courseId, contentId) }

    suspend fun learningGrades(courseId: String): List<LearningGrade> = run { learningGrades(courseId) }

    /** 多门课作业汇总;逐门失败不拖垮整体。 */
    suspend fun assignments(courses: List<CourseInfo>, forceRefresh: Boolean = false): List<AssignmentSummary> =
        coroutineScope {
            val sem = Semaphore(3)
            courses.map { course ->
                async {
                    val cached = assignmentsCache[course.id]
                        ?.takeIf { !forceRefresh && it.fresh(TTL) }
                        ?.data
                    if (cached != null) {
                        cached
                    } else {
                        sem.acquire()
                        try {
                            val fresh = try {
                                withReauth(auth, Service.COURSE) { api.listAssignmentsForCourse(course) }
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                emptyList()
                            }
                            fresh.also { assignmentsCache[course.id] = CacheEntry(it) }
                        } finally {
                            sem.release()
                        }
                    }
                }
            }.flatMap { it.await() }
        }

    /** 单门课的作业列表(课程详情页用)。 */
    suspend fun assignmentsForCourse(courseId: String, courseName: String): List<AssignmentSummary> =
        run { listAssignmentsForCourse(CourseInfo(courseId, courseName, true)) }

    /** 下载附件到 应用专属 Download/OnePKU/<courseName>/,返回文件。 */
    suspend fun download(courseName: String, attachment: Attachment): File {
        val dir = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            "OnePKU/${sanitize(courseName)}",
        )
        val dest = File(dir, sanitize(attachment.name))
        if (dest.exists() && dest.length() > 0) return dest
        return run { downloadFile(attachment.url, dest) }
    }

    /** 预览用:落到缓存的 previews 目录,不混进课程资料;同名文件不重复下载。 */
    suspend fun cachedFile(attachment: Attachment): File {
        val dir = File(context.cacheDir, "previews").apply { mkdirs() }
        val dest = File(dir, sanitize(attachment.name))
        if (dest.exists() && dest.length() > 0) return dest
        return run { downloadFile(attachment.url, dest) }
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
        // 上传已被接受;核对只读不写,失败不回滚也不重发。作业缓存作废,今日与作业页才看得到已提交。
        assignmentsCache.remove(courseId)
        val snapshot = tryOrNull { run { submissionSnapshot(courseId, contentId) } }
        val receipt = snapshot?.files?.lastOrNull()
        var reason: String? = null
        val remote = receipt?.let {
            try {
                run { submittedFileBytes(it.url, courseId) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                reason = e.message ?: e.javaClass.simpleName
                null
            }
        }
        staged.delete()
        if (receipt == null) {
            return SubmissionOutcome.Unverified("学校已接收提交,但未获取到回执附件,请在教学网核对")
        }
        if (remote == null) {
            return SubmissionOutcome.Unverified("回执已出现(${receipt.name}),但下载核对失败:${reason ?: "原因未知"}")
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
