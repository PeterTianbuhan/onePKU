package me.petertian.onepku.data.treehole

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.network.SmsVerificationRequiredException
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import kotlin.math.pow

data class ScoreEntry(
    val name: String,
    val credit: String,
    val score: String,
    val category: String,
    val year: String,
    val term: String,
) {
    val termKey: String get() = "$year-$term"

    /** 手动调整口径时的稳定标识:同一学期同名课程视为一条。 */
    val scopeKey: String get() = "$termKey|$name"
}

data class TermGpa(val term: String, val gpa: String)

/** 专业必修/限选口径的课程类别判定。 */
fun ScoreEntry.isMajorRequired(): Boolean =
    category.contains("专业必修") || category.contains("专业限选")

/** 手动调整:有些专业课在学校系统里被标成"任选",按类别自动统计会漏掉。 */
data class ScopeOverride(val included: Set<String> = emptySet(), val excluded: Set<String> = emptySet())

fun ScoreEntry.countsAsMajor(override: ScopeOverride): Boolean =
    scopeKey in override.included || (isMajorRequired() && scopeKey !in override.excluded)

enum class GradeScope(val label: String) {
    ALL("全部课程"),
    MAJOR("专业必修/限选"),
}

data class GradeStats(
    val gpa: Double?,
    val weightedAvg: Double?,
    val credits: Double,
    val courseCount: Int,
)

data class ScoreReport(
    val entries: List<ScoreEntry>,
    /** 学校返回的总 GPA(仅适用于全部课程口径);为 null 时只能本地计算 */
    val schoolGpa: String?,
    val totalCredits: String?,
    val termGpas: List<TermGpa>,
) {
    fun stats(scope: GradeScope, override: ScopeOverride = ScopeOverride()): GradeStats =
        computeGradeStats(entries, scope, override)

    /** 学期键(如 "25-26-1")在该口径下的本地统计。 */
    fun termStats(termKey: String, scope: GradeScope, override: ScopeOverride = ScopeOverride()): GradeStats =
        computeGradeStats(entries.filter { it.termKey == termKey }, scope, override)
}

class TreeholeApiException(message: String) : Exception(message)

/** 树洞:正式成绩、GPA、短信验证。 */
class TreeholeApi @Inject constructor(
    private val httpFactory: HttpFactory,
    private val sessionStore: SessionStore,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private fun authHeaders(): Pair<String, String> {
        val session = sessionStore.session(Service.TREEHOLE)
            ?: throw SessionExpiredException("树洞未登录")
        if (session.isExpired()) throw SessionExpiredException()
        val uuid = session.extra["full_uuid"] ?: throw SessionExpiredException("树洞设备标识缺失")
        return session.token to uuid
    }

    private suspend fun apiGet(path: String): JsonObject = withContext(Dispatchers.IO) {
        val (token, uuid) = authHeaders()
        val client = httpFactory.client(
            ua = Ua.DESKTOP,
            headers = mapOf("authorization" to "Bearer $token", "uuid" to uuid),
        )
        client.newCall(Request.Builder().url("$TREEHOLE_BASE$path").build()).execute().use { resp ->
            val body = resp.requireBody().string()
            if (resp.code == 401) throw SessionExpiredException()
            val obj = runCatching { json.parseToJsonElement(body).jsonObject }
                .getOrElse { throw TreeholeApiException("响应无法解析: HTTP ${resp.code}") }
            checkCode(obj)
            obj
        }
    }

    private suspend fun apiPostJson(path: String, bodyJson: String): JsonObject = withContext(Dispatchers.IO) {
        val (token, uuid) = authHeaders()
        val client = httpFactory.client(
            ua = Ua.DESKTOP,
            headers = mapOf("authorization" to "Bearer $token", "uuid" to uuid),
        )
        val request = Request.Builder()
            .url("$TREEHOLE_BASE$path")
            .post(bodyJson.toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { resp ->
            val body = resp.requireBody().string()
            val obj = runCatching { json.parseToJsonElement(body).jsonObject }
                .getOrElse { throw TreeholeApiException("响应无法解析: HTTP ${resp.code}") }
            obj
        }
    }

    private fun checkCode(obj: JsonObject) {
        val code = obj["code"]?.jsonPrimitive?.longOrNull ?: return
        when (code) {
            40002L -> throw SmsVerificationRequiredException()
            40077L -> throw TreeholeApiException("树洞要求二次授权,请在树洞网页版完成一次课程授权后再试")
            401L -> throw SessionExpiredException()
        }
    }

    // ---- 短信验证 ----

    suspend fun sendSmsCode(): String {
        val obj = apiPostJson("/chapi/api/jwt_send_msg", "{}")
        val success = obj["success"]?.jsonPrimitive?.content == "true"
        val message = obj["message"]?.jsonPrimitive?.content.orEmpty()
        if (!success && !message.contains("未过期")) {
            throw TreeholeApiException("发送验证码失败: $message")
        }
        return message.ifEmpty { "验证码已发送" }
    }

    suspend fun verifySmsCode(code: String) {
        require(code.matches(Regex("\\d{4,8}"))) { "验证码为 4-8 位数字" }
        val obj = apiPostJson("/chapi/api/jwt_msg_verify", """{"valid_code":"$code"}""")
        val success = obj["success"]?.jsonPrimitive?.content == "true"
        if (!success) {
            throw TreeholeApiException("验证失败: ${obj["message"]?.jsonPrimitive?.content.orEmpty()}")
        }
    }

    // ---- 正式成绩 ----

    suspend fun scores(): ScoreReport {
        val obj = apiGet("/chapi/api/course/score_v2")
        val data = obj["data"]?.jsonObject ?: throw TreeholeApiException("成绩数据为空")
        val score = data["score"]?.jsonObject

        val entries = score?.get("cjxx")?.jsonArray.orEmpty().mapNotNull { el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            fun s(key: String) = o[key]?.jsonPrimitive?.content.orEmpty()
            ScoreEntry(
                name = s("kcmc"),
                credit = s("xf"),
                score = s("xqcj"),
                category = s("kclbmc"),
                year = s("xnd"),
                term = s("xq"),
            )
        }

        val gpaObj = score?.get("gpa")?.jsonObject
        val schoolGpa = gpaObj?.get("gpa")?.jsonPrimitive?.content
        val totalCredits = gpaObj?.get("xxxf")?.jsonPrimitive?.content

        val termGpas = data["gpa"]?.jsonObject?.get("data")?.jsonArray.orEmpty().mapNotNull { el ->
            val o = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val term = o["xndxq"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val gpa = o["gpa"]?.jsonPrimitive?.content ?: return@mapNotNull null
            TermGpa(term, gpa)
        }

        return ScoreReport(
            entries = entries,
            schoolGpa = schoolGpa?.takeIf { it.toDoubleOrNull()?.let { g -> g in 0.0..4.0 } == true },
            totalCredits = totalCredits,
            termGpas = termGpas,
        )
    }

    companion object {
        const val TREEHOLE_BASE = "https://treehole.pku.edu.cn"
    }
}

/**
 * 北大 2019 年 9 月规则:单课程绩点 = 4 - 3(100-x)^2/1600(x>=60,否则 0);
 * GPA 按学分加权。排除非数字成绩、学分<=0、毕业论文/综合性考试;重修各次都计入。
 * MAJOR 口径只统计课程类别含"专业必修"或"专业限选"的课程。
 */
fun computeGradeStats(
    entries: List<ScoreEntry>,
    scope: GradeScope,
    override: ScopeOverride = ScopeOverride(),
): GradeStats {
    var gpaPoints = 0.0
    var scoreSum = 0.0
    var creditSum = 0.0
    var count = 0
    for (e in entries) {
        if (scope == GradeScope.MAJOR && !e.countsAsMajor(override)) continue
        if (e.name.contains("毕业论文") || e.category.contains("毕业论文") ||
            e.name.contains("综合性考试") || e.category.contains("综合性考试")
        ) continue
        val s = e.score.toDoubleOrNull() ?: continue
        if (s > 100) continue
        val c = e.credit.toDoubleOrNull() ?: continue
        if (c <= 0) continue
        val point = if (s < 60) 0.0 else 4 - 3 * (100 - s).pow(2) / 1600
        gpaPoints += point * c
        scoreSum += s * c
        creditSum += c
        count++
    }
    return GradeStats(
        gpa = if (creditSum > 0) gpaPoints / creditSum else null,
        weightedAvg = if (creditSum > 0) scoreSum / creditSum else null,
        credits = creditSum,
        courseCount = count,
    )
}
