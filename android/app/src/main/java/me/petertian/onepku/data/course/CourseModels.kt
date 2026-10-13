package me.petertian.onepku.data.course

enum class ContentType { ASSIGNMENT, FOLDER, DOCUMENT }

data class Attachment(val name: String, val url: String)

data class CourseInfo(val id: String, val longTitle: String, val isCurrent: Boolean) {
    /** "26271-x: 数据结构与算法 (26-27学年第1学期)" → "数据结构与算法" */
    val name: String
        get() = longTitle.substringAfter(": ").substringBeforeLast(" (").ifBlank { longTitle }

    /** "26271-x: 数据结构与算法 (26-27学年第1学期)" → "26-27学年第1学期" */
    val semester: String
        get() = Regex("\\(([^()]*)\\)\\s*$").find(longTitle)?.groupValues?.get(1) ?: "其他"
}

data class CourseEntry(val name: String, val url: String)

data class ContentItem(
    val id: String,
    val title: String,
    val type: ContentType,
    val url: String?,
    val attachments: List<Attachment>,
    val description: String,
    val hasLink: Boolean,
)

data class Announcement(
    val id: String,
    val courseId: String,
    val courseName: String = "",
    val title: String,
    val bodyHtml: String,
    val date: String,
    val author: String,
)

data class AssignmentSummary(
    val courseId: String,
    val courseName: String,
    val contentId: String,
    val title: String,
    val deadlineRaw: String?,
    val deadlineEpochMs: Long?,
    /** 提交与否只看学校提交记录与成绩中心,不信作业页文案。 */
    val submitted: Boolean = false,
    /** 成绩中心给出的分数原文;缺失时不假设为 0。 */
    val scoreText: String? = null,
    /** 当前尝试的提交时刻;学校页面没给出时为空,不拿截止时间冒充。 */
    val submittedAtEpochMs: Long? = null,
)

data class AssignmentDetail(
    val title: String,
    val deadlineRaw: String?,
    val deadlineEpochMs: Long?,
    val instructions: String,
    val attachments: List<Attachment>,
)

data class FeedbackAttempt(
    val id: String,
    val label: String,
    val score: String?,
    val pointsPossible: String?,
    val feedback: String?,
    val files: List<Attachment>,
    val url: String,
)

data class LearningGrade(
    val id: String,
    val title: String,
    val category: String,
    val score: String,
    val activity: String,
    val updated: String,
    val status: String,
)

/** 当前尝试页的提交快照:第几次尝试 + 已提交文件。 */
data class SubmissionSnapshot(
    val label: String?,
    val files: List<Attachment>,
    /** 尝试行的提交时刻,如 "26-9-28 下午10:22";认不出时为空。 */
    val submittedAtEpochMs: Long? = null,
) {
    val submitted: Boolean get() = label != null || files.isNotEmpty()
}

/** 提交结果:回执文件与本地文件 SHA-256 一致才算已确认。 */
sealed interface SubmissionOutcome {
    data class Confirmed(val fileName: String) : SubmissionOutcome
    data class Unverified(val reason: String) : SubmissionOutcome
}
