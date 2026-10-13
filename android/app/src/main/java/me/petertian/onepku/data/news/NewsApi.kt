package me.petertian.onepku.data.news

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.Ua
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.jsoup.Jsoup
import org.jsoup.safety.Safelist
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

data class NewsItem(
    val id: String,
    val source: WebSource,
    val title: String,
    val date: String,
    val department: String,
    val url: String,
    val location: String = "",
    val speaker: String = "",
    val eventStart: String = "",
    val eventEnd: String = "",
)

class NewsApiException(message: String) : Exception(message)

/** 教务部 / 信科 / 图书馆活动 通知抓取。仅首页,无需登录。 */
class NewsApi @Inject constructor(private val httpFactory: HttpFactory) {

    private val json = Json { ignoreUnknownKeys = true }

    private suspend fun get(url: String): String = withContext(Dispatchers.IO) {
        val client = httpFactory.client(ua = Ua.NEWS)
        client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw NewsApiException("请求失败: HTTP ${resp.code}")
            resp.requireBody().string()
        }
    }

    suspend fun list(source: WebSource): List<NewsItem> = when (source) {
        WebSource.DEAN -> deanList()
        WebSource.EECS -> eecsList()
        WebSource.LIBRARY -> libraryList()
        WebSource.SCHOOL -> throw NewsApiException("本院通知请按院系选择")
    }

    // ---- 教务部 ----

    private suspend fun deanList(): List<NewsItem> {
        val doc = Jsoup.parse(get(WebSource.DEAN.home), WebSource.DEAN.home)
        return doc.select("div.notice_item").take(40).mapNotNull { row ->
            val a = row.select("a").first() ?: return@mapNotNull null
            val title = a.text().trim()
            val url = a.absUrl("href")
            if (title.isEmpty() || url.isEmpty()) return@mapNotNull null
            val date = row.select("span").first()?.text()?.trim().orEmpty()
            NewsItem(
                id = "dean-$url",
                source = WebSource.DEAN,
                title = title,
                date = date,
                department = "教务部",
                url = url,
            )
        }.ifEmpty { throw NewsApiException("教务部通知页面未识别到内容") }
    }

    // ---- 信科 ----

    private suspend fun eecsList(): List<NewsItem> {
        val doc = Jsoup.parse(get(WebSource.EECS.home), WebSource.EECS.home)
        return doc.select("ul.list-text > li > a").take(40).mapNotNull { a ->
            val title = a.select(".tit").first()?.text()?.trim().orEmpty()
            val url = a.absUrl("href")
            if (title.isEmpty() || url.isEmpty()) return@mapNotNull null
            val mon = a.select(".date .mon").first()?.text()?.trim().orEmpty()
            val day = a.select(".date .day").first()?.text()?.trim().orEmpty()
            NewsItem(
                id = "eecs-$url",
                source = WebSource.EECS,
                title = title,
                date = "$mon-$day".trim('-'),
                department = "信息科学技术学院",
                url = url,
            )
        }.ifEmpty { throw NewsApiException("信科通知页面未识别到内容") }
    }

    // ---- 图书馆活动 ----

    private suspend fun libraryList(): List<NewsItem> = withContext(Dispatchers.IO) {
        val now = Date()
        val month = SimpleDateFormat("MM", Locale.US).format(now)
        val year = SimpleDateFormat("yyyy", Locale.US).format(now)
        val url = "https://www.lib.pku.edu.cn/cms/front/content/list/all".toHttpUrl().newBuilder()
            .addQueryParameter("currentPage", "1")
            .addQueryParameter("pageSize", "100")
            .addQueryParameter("month", month)
            .addQueryParameter("year", year)
            .addQueryParameter("siteId", "4b31754d8b064919b62798460f297002")
            .build().toString()
        val obj = json.parseToJsonElement(get(url)).jsonObject
        if (obj["status"]?.jsonPrimitive?.longOrNull != 200L) {
            throw NewsApiException("图书馆活动服务暂不可用")
        }
        obj["object"]?.jsonArray.orEmpty().mapNotNull { el ->
            val r = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            fun s(k: String) = r[k]?.jsonPrimitive?.content?.trim().orEmpty()
            val title = s("name")
            val link = s("path")
            if (title.isEmpty() || link.isEmpty()) return@mapNotNull null
            NewsItem(
                id = "library-$link|${s("kssj")}|${s("jssj")}",
                source = WebSource.LIBRARY,
                title = title,
                date = libTime(s("modifiedDate")).ifEmpty { libTime(s("publishDate")) },
                department = "图书馆",
                url = link,
                location = s("hddd"),
                speaker = s("zcr"),
                eventStart = libTime(s("kssj")),
                eventEnd = libTime(s("jssj")),
            )
        }
    }

    private fun libTime(raw: String): String {
        if (raw.isBlank()) return ""
        val input = listOf("yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm")
        for (f in input) {
            runCatching {
                val d = SimpleDateFormat(f, Locale.US).parse(raw) ?: return@runCatching
                return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(d)
            }
        }
        return ""
    }

    // ---- 正文 ----

    /** 抓取正文并做白名单清洗,相对链接按原文页重写。 */
    suspend fun detail(item: NewsItem): String {
        val body = get(item.url)
        val doc = Jsoup.parse(body, item.url)
        val selector = when (item.source) {
            WebSource.DEAN -> ".newsinfo_box"
            WebSource.EECS -> ".Section1, .v_news_content, .article"
            WebSource.LIBRARY -> ".article"
            // 各院系 CMS 不一,取候选容器里正文最多的那个。
            WebSource.SCHOOL -> ".v_news_content, .article-p, .article, #vsb_content, " +
                ".TRS_Editor, .newscontent, .content, .details, .article-body"
        }
        val container = doc.select(selector).maxByOrNull { it.text().length }
            ?: throw NewsApiException("正文暂不可用,请阅读原文")
        val html = if (item.source == WebSource.DEAN) {
            container.children()
                .filterNot { it.tagName() == "h1" || it.tagName() == "span" || it.hasClass("share_ds") }
                .joinToString("") { it.outerHtml() }
        } else {
            container.html()
        }
        if (html.isBlank()) throw NewsApiException("正文暂不可用,请阅读原文")
        return sanitize(html, item.url)
    }

    private fun sanitize(html: String, baseUri: String): String {
        val safelist = Safelist.relaxed()
            .addTags("table", "thead", "tbody", "tr", "td", "th")
            .addAttributes("a", "target", "rel")
            .addProtocols("img", "src", "http", "https")
        val clean = Jsoup.clean(html, baseUri, safelist)
        // 链接新窗口打开(在 WebView 中拦截)
        return clean.replace("<a ", "<a target=\"_blank\" rel=\"noopener noreferrer\" ")
    }
}

enum class WebSource(val label: String, val home: String) {
    DEAN("教务部", "https://dean.pku.edu.cn/web/notice.php"),
    EECS("信科", "https://eecs.pku.edu.cn/tzgg.htm"),
    LIBRARY("图书馆", "https://www.lib.pku.edu.cn/hdrl/index.htm"),
    /** 本院通知:站点随院系变化,详情见 SchoolNoticeApi。 */
    SCHOOL("本院", ""),
}
