package me.petertian.onepku.data.portal

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import me.petertian.onepku.core.network.CookieStores
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Request
import javax.inject.Inject

data class ClassroomRow(
    val room: String,
    val capacity: String,
    /** 12 节,true = 被占用 */
    val occupied: List<Boolean>,
)

data class PortalNotice(
    val id: String,
    val title: String,
    val date: String,
    val department: String,
    val url: String,
)

data class PortalProfile(val name: String, val department: String)

data class NoticePage(
    val items: List<PortalNotice>,
    val hasMore: Boolean,
    val total: Long,
)

class PortalApiException(message: String) : Exception(message)

/** 门户接口:空闲教室与通知无需登录;基本信息(单位/姓名)需 IAAA 登录。 */
class PortalApi @Inject constructor(
    private val httpFactory: HttpFactory,
    private val cookieStores: CookieStores,
    private val sessionStore: SessionStore,
) {

    private val json = Json { ignoreUnknownKeys = true }

    private suspend fun getJson(url: String) = withContext(Dispatchers.IO) {
        val client = httpFactory.client(ua = Ua.NEWS)
        client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw PortalApiException("请求失败: HTTP ${resp.code}")
            json.parseToJsonElement(resp.requireBody().string()).jsonObject
        }
    }

    private suspend fun postForm(url: String, form: Map<String, String>) = withContext(Dispatchers.IO) {
        val client = httpFactory.client(ua = Ua.NEWS)
        val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
        client.newCall(Request.Builder().url(url).post(body).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw PortalApiException("请求失败: HTTP ${resp.code}")
            json.parseToJsonElement(resp.requireBody().string()).jsonObject
        }
    }

    // ---- 空闲教室 ----

    suspend fun freeClassrooms(building: String, day: ClassroomDay): List<ClassroomRow> {
        val url = "$PORTAL_PUBLIC/classroomQuery/retrClassRoomFree.do?buildingName=${enc(building)}&time=${enc(day.query)}"
        val obj = getJson(url)
        val rows = obj["rows"]?.jsonArray ?: return emptyList()
        return rows.mapNotNull { el ->
            val r = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            fun s(k: String) = r[k]?.jsonPrimitive?.content.orEmpty()
            val occupied = (1..12).map { i -> s("c$i").isNotEmpty() }
            ClassroomRow(room = s("room"), capacity = s("cap"), occupied = occupied)
        }
    }

    // ---- 学校 / 部门通知 ----

    suspend fun notices(source: NoticeSource, page: Int): NoticePage {
        val endpoint = when (source) {
            NoticeSource.SCHOOL -> "retrAllSchoolNotice.do"
            NoticeSource.DEPARTMENT -> "retrAllDeptNotice.do"
        }
        val obj = postForm(
            "$PORTAL2017/notice/$endpoint",
            mapOf("keyword" to "ALL", "limit" to "20", "start" to ((page - 1) * 20).toString()),
        )
        if (obj["success"]?.jsonPrimitive?.content != "true") {
            throw PortalApiException("学校通知服务未返回数据")
        }
        val rows = obj["rows"]?.jsonArray.orEmpty()
        val items = rows.mapNotNull { el ->
            val r = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            val id = r["Number"]?.jsonPrimitive?.content.orEmpty()
            if (id.isEmpty()) return@mapNotNull null
            PortalNotice(
                id = id,
                title = r["Title"]?.jsonPrimitive?.content.orEmpty(),
                date = r["Time"]?.jsonPrimitive?.content.orEmpty(),
                department = r["Department"]?.jsonPrimitive?.content.orEmpty(),
                url = "$PORTAL2017/#/schoolNoticeDetail/$id",
            )
        }
        return NoticePage(
            items = items,
            hasMore = rows.size == 20,
            total = obj["results"]?.jsonPrimitive?.longOrNull ?: 0,
        )
    }

    /** 通知正文(HTML)。学校与部门通知共用该详情接口。 */
    suspend fun noticeDetail(id: String): String {
        val obj = postForm("$PORTAL2017/notice/getSchoolNoticeDetailById.do", mapOf("id" to id))
        if (obj["success"]?.jsonPrimitive?.content != "true") {
            throw PortalApiException("通知正文暂不可用")
        }
        return obj["notice"]?.jsonObject?.get("noticeContent")?.jsonPrimitive?.content
            ?: throw PortalApiException("通知正文格式变化")
    }

    // ---- 登录态:我的信息 ----

    /**
     * 门户"我的信息"里的单位即用户所在院系。
     * 未登录时学校返回的是跳转登录的 HTML,据此判定会话过期。
     */
    suspend fun basicInfo(): PortalProfile = withContext(Dispatchers.IO) {
        val session = sessionStore.session(Service.PORTAL)
            ?: throw SessionExpiredException("校内门户未登录")
        if (session.isExpired()) throw SessionExpiredException()
        val client = httpFactory.client(
            cookieJar = cookieStores.jar(Service.PORTAL.key),
            ua = Ua.DESKTOP,
            headers = mapOf("referer" to "$PORTAL2017/", "x-requested-with" to "XMLHttpRequest"),
        )
        client.newCall(
            Request.Builder().url("$PORTAL2017/account/getBasicInfo.do")
                // 网页端是 Angular 的 POST,空体 + JSON content-type。
                .post("".toRequestBody(JSON_TYPE)).build()
        ).execute().use { resp ->
            val body = resp.requireBody().string()
            // 未登录时学校返回跳转登录的 HTML,而不是 JSON。
            val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
                ?: throw SessionExpiredException("门户会话已失效")
            if (obj["success"]?.jsonPrimitive?.content != "true") {
                throw PortalApiException("门户未返回用户信息")
            }
            PortalProfile(
                name = obj["name"]?.jsonPrimitive?.content.orEmpty(),
                department = obj["department"]?.jsonPrimitive?.content.orEmpty(),
            )
        }
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

    companion object {
        const val PORTAL_PUBLIC = "https://portal.pku.edu.cn/publicQuery"
        const val PORTAL2017 = "https://portal.pku.edu.cn/portal2017"
        private val JSON_TYPE = "application/json; charset=UTF-8".toMediaType()

        val BUILDINGS = listOf("一教", "二教", "三教", "四教", "理教", "文史", "哲学", "地学", "国关", "政管")
    }
}

enum class ClassroomDay(val label: String, val query: String) {
    TODAY("今天", "今天"),
    TOMORROW("明天", "明天"),
    DAY_AFTER("后天", "后天"),
}

enum class NoticeSource(val label: String) {
    SCHOOL("学校通知"),
    DEPARTMENT("部门通知"),
}
