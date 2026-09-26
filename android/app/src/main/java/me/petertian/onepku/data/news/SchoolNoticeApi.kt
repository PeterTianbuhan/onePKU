package me.petertian.onepku.data.news

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.data.portal.NoticeSource
import me.petertian.onepku.data.portal.PortalApi
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

data class SchoolSite(val name: String, val home: String, val notice: String?)

/** 本院通知来源:学院官网,或门户部门通知过滤。 */
sealed interface SchoolNoticeItem {
    data class FromSite(val item: NewsItem) : SchoolNoticeItem
    data class FromPortal(val notice: me.petertian.onepku.data.portal.PortalNotice) : SchoolNoticeItem
}

data class SchoolNotices(val school: String, val items: List<SchoolNoticeItem>)

/**
 * 本院通知:已适配的学院直接抓官网通知页,其余回退到门户"部门通知"按院系过滤。
 * 门户接口不支持按院系查询,只能翻一段最近的记录再本地匹配。
 */
@Singleton
class SchoolNoticeApi @Inject constructor(
    @ApplicationContext private val context: Context,
    private val httpFactory: HttpFactory,
    private val portal: PortalApi,
    private val news: NewsApi,
) {
    private val directory: Map<String, SchoolSite> by lazy { loadDirectory() }

    fun schools(): List<String> = directory.keys.sorted()

    /** 门户「单位」可能写作"生命科学学院",官网列表里又写作"生命学院",按词根匹配。 */
    fun resolve(department: String): SchoolSite? {
        val wanted = department.trim()
        if (wanted.isEmpty()) return null
        directory[wanted]?.let { return it }
        directory[wanted.removeSuffix("学院").ifEmpty { wanted } + "学院"]?.let { return it }
        return directory.values.firstOrNull { site ->
            val a = coreOf(site.name)
            val b = coreOf(wanted)
            a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a))
        }
    }

    private fun coreOf(name: String): String =
        name.removeSuffix("学院").removeSuffix("大学").removeSuffix("系").removeSuffix("研究所")

    suspend fun list(department: String): SchoolNotices {
        val site = resolve(department) ?: throw NewsApiException("未识别到院系列表,请在设置里手动选择")
        if (site.name == "信息科学技术学院") {
            return SchoolNotices(site.name, news.list(WebSource.EECS).map(SchoolNoticeItem::FromSite))
        }
        val listUrl = site.notice?.let { https(it) }
        val items = listUrl?.let { url ->
            // 学院站改版或证书异常时退回门户,而不是让通知页直接空掉。
            runCatching { fetchSite(url) }.getOrNull()?.map(SchoolNoticeItem::FromSite)
        }
        return SchoolNotices(site.name, items ?: portalNotices(site.name).map(SchoolNoticeItem::FromPortal))
    }

    /** Android 默认禁止明文 HTTP;学校站基本都提供 HTTPS,优先升级。 */
    private fun https(url: String): String {
        if (!url.startsWith("http://")) return url
        val rest = url.removePrefix("http://")
        val host = rest.substringBefore('/').substringBefore(':')
        return if (PKU_HOST.containsMatchIn(host)) "https://$rest" else url
    }

    private suspend fun fetchSite(listUrl: String): List<NewsItem> = withContext(Dispatchers.IO) {
        val client = httpFactory.client(ua = Ua.NEWS)
        val html = client.newCall(Request.Builder().url(listUrl).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw NewsApiException("学院通知页读取失败: HTTP ${resp.code}")
            resp.requireBody().string()
        }
        parseSite(Jsoup.parse(html, listUrl), listUrl)
    }

    /** 各校 CMS 模板不一,按"详情链接 + 附近日期"通用提取。 */
    private fun parseSite(doc: org.jsoup.nodes.Document, listUrl: String): List<NewsItem> {
        val base = listUrl.toHttpUrl()
        val found = mutableMapOf<String, NewsItem>()
        val seen = mutableSetOf<String>()
        for (a in doc.select("a[href]")) {
            val url = runCatching { a.absUrl("href").toHttpUrl() }.getOrNull() ?: continue
            if (url.host != base.host) continue
            if (!DETAIL_PATH.containsMatchIn(url.encodedPath)) continue
            val title = (a.attr("title").ifBlank {
                a.selectFirst("h4, h3, .tit, .l2")?.text().orEmpty()
            }.ifBlank { a.text() })
                .replace(WHITESPACE, " ")
                .replace(LEADING_DATE, "")
                .trim()
            if (title.length < 6) continue
            val date = dateOf(a) ?: continue
            // 同一则通知常有"标题 + 更多"多个链接,也可能整页重复渲染。
            if (!seen.add(title)) continue
            found.putIfAbsent(url.toString(), NewsItem(
                id = "school-${url.encodedPath.substringAfterLast('/')}",
                source = WebSource.SCHOOL,
                title = title.take(120),
                date = date,
                department = "",
                url = url.toString(),
            ))
        }
        return found.values.sortedByDescending { it.date }.take(25)
    }

    private fun dateOf(a: Element): String? {
        var node: Element? = a
        repeat(3) {
            node = node?.parent()
            val text = node?.text() ?: return null
            val m = DATE.find(text.replace(WHITESPACE, " ")) ?: return@repeat
            val (y, mo, d) = m.destructured
            return "%s-%02d-%02d".format(Locale.US, y, mo.toInt(), d.toInt())
        }
        return null
    }

    /** 门户部门通知按院系过滤:接口不支持服务端筛选,翻最近若干页再本地匹配。 */
    private suspend fun portalNotices(school: String): List<me.petertian.onepku.data.portal.PortalNotice> {
        val core = coreOf(school)
        val collected = mutableListOf<me.petertian.onepku.data.portal.PortalNotice>()
        var page = 1
        while (page <= PAGES && collected.size < 15) {
            val batch = portal.notices(NoticeSource.DEPARTMENT, page)
            if (batch.items.isEmpty()) break
            collected += batch.items.filter { core.length >= 2 && it.department.contains(core) }
            page++
        }
        return collected.distinctBy { it.id }.sortedByDescending { it.date }.take(25)
    }

    private fun loadDirectory(): Map<String, SchoolSite> = try {
        val raw = context.assets.open("schools.json").bufferedReader().use { it.readText() }
        Json.parseToJsonElement(raw).jsonObject.mapValues { (name, value) ->
            val o = runCatching { value.jsonObject }.getOrNull() ?: JsonObject(emptyMap())
            SchoolSite(
                name = name,
                home = o["home"]?.jsonPrimitive?.content.orEmpty(),
                notice = o["notice"]?.jsonPrimitive?.content,
            )
        }
    } catch (e: Exception) {
        emptyMap()
    }

    private companion object {
        val DETAIL_PATH = Regex("/(info|content|notice|news|tzgg|xwgg|art)/|/\\d{5,}\\.s?html?$|\\d{3,}\\.s?html?$")
        val DATE = Regex("(20\\d{2})[-/.](\\d{1,2})[-/.](\\d{1,2})")
        val LEADING_DATE = Regex("^(20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}\\s*[:：]?\\s*)+")
        val WHITESPACE = Regex("\\s+")
        val PKU_HOST = Regex("(pku|bjmu|pkusz)\\.edu\\.cn$")
        const val PAGES = 10
    }
}
