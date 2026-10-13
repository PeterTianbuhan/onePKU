package me.petertian.onepku.data.curriculum

import kotlinx.serialization.Serializable

@Serializable
data class PlanCourse(
    val code: String = "",
    val name: String = "",
    val nature: String? = null,
    val credits: Double? = null,
    val hours: Double? = null,
    val practice: Double? = null,
    val term: String? = null,
)

@Serializable
data class PlanAlternative(
    val code: String = "",
    val name: String = "",
    val credits: Double? = null,
    val replaces: String? = null,
)

@Serializable
data class PlanGroup(
    val id: String,
    val parent: String? = null,
    val kind: String? = null,
    val name: String = "",
    val note: String? = null,
    val requirement: String? = null,
    val min: Double? = null,
    val max: Double? = null,
    val unit: String? = null,
    val courses: List<PlanCourse> = emptyList(),
    val alternatives: List<PlanAlternative> = emptyList(),
)

@Serializable
data class PlanRequirement(
    val id: String,
    val parent: String = "",
    val name: String = "",
    val requirement: String = "",
    val min: Double? = null,
    val max: Double? = null,
    val unit: String? = null,
    val inferredParent: Boolean = false,
)

@Serializable
data class CreditRange(val min: Double = 0.0, val max: Double = 0.0)

@Serializable
data class TopRequirement(
    val id: String,
    val name: String = "",
    val min: Double? = null,
    val max: Double? = null,
    val unit: String? = null,
)

@Serializable
data class PlanSource(
    val volumeId: String = "",
    val url: String = "",
    val lineStart: Int = 0,
    val lineEnd: Int = 0,
    /** 整卷 PDF 中的页码范围(从 1 起)。手机端不抽页,只用于提示原文位置。 */
    val pageStart: Int? = null,
    val pageEnd: Int? = null,
    val pageLabels: List<Int>? = null,
)

@Serializable
data class UnparsedLine(val code: String = "", val line: Int = 0, val text: String = "")

@Serializable
data class TitleInference(val from: Int = 0, val title: String = "", val overlap: Int = 0)

@Serializable
data class Plan(
    val id: String,
    val cohort: Int = 0,
    val volume: String = "",
    val school: String? = null,
    val major: String = "",
    val track: String? = null,
    val title: String = "",
    val kind: String = "major",
    val degree: String? = null,
    val totalCredits: CreditRange? = null,
    val topRequirements: List<TopRequirement> = emptyList(),
    val requirements: List<PlanRequirement> = emptyList(),
    val groups: List<PlanGroup> = emptyList(),
    val notes: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
    val unparsed: List<UnparsedLine> = emptyList(),
    val titleInference: TitleInference? = null,
    val source: PlanSource = PlanSource(),
)

@Serializable
data class PlanIndexEntry(
    val id: String,
    val cohort: Int = 0,
    val school: String? = null,
    val major: String = "",
    val track: String? = null,
    val title: String = "",
    val kind: String = "major",
    val degree: String? = null,
    val totalCredits: CreditRange? = null,
    val volume: String = "",
    /** 相对 data/curriculum 的路径,已含年份目录。 */
    val file: String = "",
    val courses: Int = 0,
    val warnings: Int = 0,
    val core: List<String> = emptyList(),
)

@Serializable
data class PlanIndex(
    val generatedAt: String = "",
    val source: String = "",
    val plans: List<PlanIndexEntry> = emptyList(),
)
