package me.petertian.onepku.data.replay

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URLDecoder
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 好学课堂实录 App 接口的纯解析部分，与桌面端 crates/campus-core/src/haoxue.rs 同一套规则。
 * 教学网「视频」栏目只列教师手工发布的回放，按学生身份查好学才有全部课次。
 * 公共参数与签名密钥取自好学安卓客户端，是公开的客户端常量，不是用户凭证。
 */
object Haoxue {
    const val BASE = "https://yjapise.pku.edu.cn/courseapi/"
    private const val TENANT = "d438cafb4c34b3b49b3a523bbef50203"
    private const val SECRET = "8225ca5fa4d56d6fde540db6024fba39"

    /** 好学安卓客户端的 WebView 身份：中转页按 UA 决定要不要交出令牌。 */
    const val ANDROID_UA =
        "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** 按键排序后拼接「键+值」，再拼密钥做 MD5。tenantid 与 tenantId 都要带、都参与签名。 */
    fun signed(input: List<Pair<String, String>>): List<Pair<String, String>> {
        val params = (
            listOf(
                "tenantid" to TENANT,
                "tenantId" to TENANT,
                "api_version" to "3.12.0",
                "app_id" to "50",
                "client" to "android",
            ) + input
            ).sortedBy { it.first }
        val raw = params.joinToString("") { it.first + it.second } + SECRET
        val digest = MessageDigest.getInstance("MD5").digest(raw.toByteArray(Charsets.UTF_8))
        return params + ("sign" to digest.joinToString("") { "%02x".format(it) })
    }

    fun scalar(value: JsonElement?, key: String): String {
        val field = (value as? JsonObject)?.get(key) ?: return ""
        if (field is JsonNull || field !is JsonPrimitive) return ""
        return field.content.trim()
    }

    fun array(value: JsonElement?, key: String): List<JsonElement> =
        ((value as? JsonObject)?.get(key) as? JsonArray)?.toList().orEmpty()

    fun pick(row: JsonElement?, vararg keys: String): String =
        keys.asSequence().map { scalar(row, it) }.firstOrNull { it.isNotEmpty() }.orEmpty()

    class ApiException(message: String) : Exception(message)
    class ExpiredException : Exception("课堂实录登录已失效")

    /** 学校接口把业务失败放在 200 响应里，`err` 401 表示 app-login 令牌失效。 */
    fun payload(body: JsonElement): JsonElement {
        if (scalar(body, "err") == "401") throw ExpiredException()
        val success = ((body as? JsonObject)?.get("success") as? JsonPrimitive)?.content
        if (success == "false") {
            throw ApiException(scalar(body, "errMsg").ifEmpty { "课堂实录接口返回失败" })
        }
        return (body as? JsonObject)?.get("data")?.takeIf { it !is JsonNull } ?: body
    }

    fun parse(text: String): JsonElement = runCatching { json.parseToJsonElement(text) }
        .getOrElse { throw ApiException("课堂实录返回的不是 JSON") }

    private fun blocked(row: JsonElement): Boolean =
        scalar(row, "publish") == "2" ||
            scalar(row, "sub_show") == "no" ||
            scalar(row, "sub_review_type") == "2" ||
            scalar(row, "deleted_at") !in setOf("", "0", "null", "None")

    /** (状态文字, 能不能播)。 */
    fun state(row: JsonElement): Pair<String, Boolean> {
        if (blocked(row)) return "已下架或未开放" to false
        val status = scalar(row, "sub_status").ifEmpty { scalar(row, "playback_status") }
        val label = when (status) {
            "6" -> "回放"
            "3" -> "回放生成中"
            "1" -> "直播中"
            "2" -> "未开始"
            "5" -> "暂无回放"
            else -> "状态待核对"
        }
        return label to (status == "6")
    }

    fun episodesOf(data: JsonElement): List<JsonElement> =
        array(data, "sub_list").ifEmpty { array(data, "lists") }

    private fun subContent(data: JsonElement): JsonElement? =
        when (val content = (data as? JsonObject)?.get("sub_content")) {
            is JsonObject -> content
            is JsonPrimitive -> if (content.isString) runCatching { json.parseToJsonElement(content.content) }.getOrNull() else null
            else -> null
        }

    fun isSchoolMedia(url: String): Boolean {
        val parsed = url.toHttpUrlOrNull() ?: return false
        return parsed.isHttps &&
            parsed.username.isEmpty() && parsed.password.isEmpty() &&
            parsed.port == 443 && !url.substringAfter("://").substringBefore('/').contains(':') &&
            (parsed.host == "pku.edu.cn" || parsed.host.endsWith(".pku.edu.cn"))
    }

    private fun isPlaylist(url: String): Boolean =
        url.toHttpUrlOrNull()?.pathSegments?.lastOrNull()?.lowercase()?.endsWith(".m3u8") == true

    data class Source(val label: String, val url: String)

    /** 只返回可分片播放的地址；只有单一文件时明确说明原因，不伪装成可播放。 */
    fun sources(body: JsonElement): List<Source> {
        val data = payload(body)
        val found = array(data, "videoArr").mapIndexedNotNull { index, variant ->
            val url = scalar(variant, "path")
            if (url.isEmpty() || !isSchoolMedia(url)) return@mapIndexedNotNull null
            Triple(scalar(variant, "tag").ifEmpty { "线路 ${index + 1}" }, url, isPlaylist(url))
        }
        if (found.any { it.third }) return found.filter { it.third }.map { Source(it.first, it.second) }
        if (found.isNotEmpty()) throw ApiException("这节课只提供单一视频文件，暂不支持分片播放")
        val playback = (subContent(data) as? JsonObject)?.get("save_playback")
        val url = scalar(playback, "contents")
        if (url.isNotEmpty() && isSchoolMedia(url)) {
            if (scalar(playback, "is_m3u8") != "yes") throw ApiException("这节课只提供单一视频文件，暂不支持分片播放")
            return listOf(Source("默认", url))
        }
        throw ApiException("这节课没有可用的录像地址")
    }

    private val beijingFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.of("Asia/Shanghai"))

    fun beijing(seconds: String): String =
        seconds.toLongOrNull()?.let { beijingFormat.format(Instant.ofEpochSecond(it)) }.orEmpty()

    /** 一节能播的课。`time` 是北京时间「yyyy-MM-dd HH:mm」，按它排序。 */
    @Serializable
    data class Lesson(
        val courseId: String,
        val episodeId: String,
        val title: String,
        val time: String,
        val courseName: String,
        val room: String = "",
    ) {
        val key: String get() = "${courseId}_$episodeId".replace(Regex("[^A-Za-z0-9_-]"), "")
    }

    /** `courseName` 传空串表示按行自带的课程名（按日期浏览时）。 */
    fun lesson(course: String, courseName: String, row: JsonElement): Lesson? {
        if (!state(row).second) return null
        val episode = pick(row, "sub_id", "id")
        val title = pick(row, "sub_title", "sub_name", "course_name")
        val time = beijing(pick(row, "class_begin", "start_at"))
        if (episode.isEmpty() || title.isEmpty() || time.isEmpty() || course.isEmpty()) return null
        return Lesson(
            courseId = course,
            episodeId = episode,
            title = title,
            time = time,
            courseName = courseName.ifEmpty { pick(row, "course_name") },
            room = pick(row, "room_name"),
        )
    }

    /** 「按日期」的每一行自带课程标识。 */
    fun datedLesson(row: JsonElement): Lesson? = lesson(pick(row, "course_id"), pick(row, "course_name"), row)

    fun normalize(value: String): String = value.filterNot { it.isWhitespace() }.lowercase()

    /** 再把全半角括号统一：「量子力学（A班）」与「量子力学(A班)」是同一门课。 */
    fun canonical(value: String): String = normalize(value).map {
        when (it) {
            '（', '[', '【' -> '('
            '）', ']', '】' -> ')'
            else -> it
        }
    }.joinToString("")

    /** 教学网课程名常带班号后缀：先按全名，再退到第一个括号或空格前的主标题。 */
    fun searchKeys(name: String): List<String> {
        val full = name.trim()
        val base = full.split('(', '（', '【', ' ').first().trim()
        return if (base.isNotEmpty() && normalize(base) != normalize(full)) listOf(full, base) else listOf(full)
    }

    /**
     * 一门课在按日期索引里的课次。先认全名；对不上再退到主标题，但只认唯一一组课名，
     * 分不清是这门课还是同名另一门时宁可不显示，也不能把别的课塞进来。
     */
    fun lessonsNamed(name: String, all: Collection<Lesson>): List<Lesson> {
        val keys = searchKeys(name)
        val exact = canonical(keys.first())
        var hits = all.filter { canonical(it.courseName) == exact }
        if (hits.isEmpty()) {
            val base = canonical(keys.last())
            val group = all.filter {
                val title = canonical(it.courseName)
                title == base || (title.startsWith("$base(") && base.length >= 3)
            }
            if (group.map { canonical(it.courseName) }.toSet().size == 1) hits = group
        }
        return hits.sortedByDescending { it.time }
    }

    // ---- 登录中转页 ----

    data class LoginPayload(val token: String, val cookieToken: String, val name: String, val account: String)

    /** app-login 交给原生桥的载荷形态不稳定：对象、JSON 文本或再编码一层，最多展开四层。 */
    private fun unwrap(value: JsonElement): JsonElement {
        var current = value
        repeat(4) {
            val text = (current as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim() ?: return current
            val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull()
            if (parsed != null && !(parsed is JsonPrimitive && parsed.content == text)) {
                current = parsed
                return@repeat
            }
            val decoded = runCatching { URLDecoder.decode(text, "UTF-8") }.getOrDefault(text)
            if (decoded == text) return current
            current = runCatching { json.parseToJsonElement(decoded) }.getOrElse { JsonPrimitive(decoded) }
        }
        return current
    }

    private fun findToken(value: JsonElement, depth: Int): JsonObject? {
        if (depth > 4 || value !is JsonObject) return null
        if (listOf("_token", "token").any { scalar(value, it).isNotEmpty() }) return value
        return value.values.firstNotNullOfOrNull { findToken(it, depth + 1) }
    }

    fun parsePayload(raw: String): LoginPayload? {
        val found = findToken(unwrap(JsonPrimitive(raw)), 0) ?: return null
        val token = scalar(found, "_token").ifEmpty { scalar(found, "token") }
        val cookie = pick(found, "_cookieToken", "cookieToken", "cookie_token").ifEmpty { token }
        return LoginPayload(token, cookie, scalar(found, "realname"), scalar(found, "account"))
    }

    /**
     * 中转页 HTML 里就有令牌：页面把它交给原生桥 `PKULoginSuccess(...)`。依次试引号参数、
     * 其后的花括号块，再退到全文前几个能解出令牌的花括号块。
     */
    fun extractPayload(html: String): String? {
        val candidates = mutableListOf<String>()
        val pos = html.indexOf("PKULoginSuccess")
        if (pos >= 0) {
            val tail = html.substring(pos)
            quotedArgument(tail)?.let(candidates::add)
            candidates += braceBlocks(tail).take(2)
        }
        candidates += braceBlocks(html).take(16)
        return candidates.firstOrNull { parsePayload(it) != null }
    }

    private fun quotedArgument(tail: String): String? {
        var i = tail.indexOf('(').takeIf { it >= 0 }?.plus(1) ?: return null
        while (i < tail.length && tail[i].isWhitespace()) i++
        val quote = tail.getOrNull(i)?.takeIf { it == '\'' || it == '"' } ?: return null
        var end = i + 1
        while (end < tail.length) {
            if (tail[end] == quote && tail[end - 1] != '\\') return tail.substring(i + 1, end)
            end++
        }
        return null
    }

    private fun braceBlocks(text: String): List<String> {
        val out = mutableListOf<String>()
        var depth = 0
        var start = 0
        var string: Char? = null
        var escaped = false
        for ((i, c) in text.withIndex()) {
            if (string != null) {
                when {
                    escaped -> escaped = false
                    c == '\\' -> escaped = true
                    c == string -> string = null
                }
                continue
            }
            when (c) {
                '\'', '"' -> string = c
                '{' -> { if (depth == 0) start = i; depth++ }
                '}' -> {
                    depth = (depth - 1).coerceAtLeast(0)
                    if (depth == 0) {
                        out += text.substring(start, i + 1)
                        if (out.size >= 6) return out
                    }
                }
            }
        }
        return out
    }
}
