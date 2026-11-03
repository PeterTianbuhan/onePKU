package me.petertian.onepku.data.replay

import kotlinx.serialization.json.JsonElement
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 好学课堂实录的请求层。都是阻塞调用：仓库层放到 IO 线程，播放器的加载线程直接调。
 * 令牌只在这里和会话存储之间流动，不进日志、界面或异常文字。
 */
@Singleton
class HaoxueApi @Inject constructor(
    private val httpFactory: HttpFactory,
    private val sessions: SessionStore,
) {
    private val apiClient: OkHttpClient by lazy { httpFactory.client(readTimeoutSec = 15) }

    /** 分片与密钥要带 `_token` Cookie；只发给 https 的 pku.edu.cn，跳转到别处时不带。 */
    val mediaClient: OkHttpClient by lazy {
        httpFactory.client(readTimeoutSec = 45).newBuilder()
            .addNetworkInterceptor(Interceptor { chain ->
                val request = chain.request()
                val cookie = sessions.session(Service.HAOXUE)?.extra?.get("cookieToken").orEmpty()
                val host = request.url.host
                val school = request.url.isHttps && (host == "pku.edu.cn" || host.endsWith(".pku.edu.cn"))
                chain.proceed(
                    if (school && cookie.isNotEmpty()) request.newBuilder().header("Cookie", "_token=$cookie").build()
                    else request.newBuilder().removeHeader("Cookie").build(),
                )
            })
            .connectTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    /** 账号指纹：按日期索引靠它绑定账号，换人登录要重建索引。 */
    fun account(): String = sessions.session(Service.HAOXUE)?.uid.orEmpty()

    private fun call(api: String, input: List<Pair<String, String>>): JsonElement {
        val token = sessions.session(Service.HAOXUE)?.token.orEmpty()
        if (token.isEmpty()) throw SessionExpiredException("未登录课堂实录")
        val url = (Haoxue.BASE + api).toHttpUrl().newBuilder().apply {
            Haoxue.signed(input).forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        val request = Request.Builder().url(url).header("token", token).header("Accept", "application/json").build()
        val text = apiClient.newCall(request).execute().use { response ->
            if (response.code == 401) throw SessionExpiredException("课堂实录登录已失效")
            if (!response.isSuccessful) throw IOException("课堂实录接口 HTTP ${response.code}")
            response.requireBody().string()
        }
        return try {
            Haoxue.payload(Haoxue.parse(text))
        } catch (_: Haoxue.ExpiredException) {
            throw SessionExpiredException("课堂实录登录已失效")
        }
    }

    fun listCourses(page: Int, search: String): List<JsonElement> =
        Haoxue.array(call("v3/course/get-use-member", listOf("page" to "$page", "search" to search)), "lists")

    fun listDate(date: String, page: Int): List<JsonElement> =
        Haoxue.array(call("v3/course/get-use-member-sub", listOf("course_time" to date, "page" to "$page")), "lists")

    fun episodes(course: String): List<JsonElement> =
        Haoxue.episodesOf(call("v3/course/get-course-detail", listOf("course_id" to course)))

    /** 一节课的可播放线路（只有分片播放列表）。 */
    fun sources(course: String, episode: String): List<Haoxue.Source> {
        val data = call("v3/course/get-course-sub-detail", listOf("course_id" to course, "sub_id" to episode))
        return Haoxue.sources(data)
    }

    /** 学校媒体资源，带大小上限；401/403 说明令牌或签名地址过期。 */
    fun media(url: String, limit: Int): ByteArray {
        if (!Haoxue.isSchoolMedia(url)) throw IOException("视频地址不在学校域名下")
        mediaClient.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (!Haoxue.isSchoolMedia(response.request.url.toString())) throw IOException("视频地址跳到了学校以外")
            if (response.code == 401 || response.code == 403) throw MediaDeniedException(response.code)
            if (!response.isSuccessful) throw IOException("视频服务返回 HTTP ${response.code}")
            val body = response.requireBody()
            if (body.contentLength() > limit) throw IOException("视频片段超出大小限制")
            val bytes = body.byteStream().use { stream ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    out.write(buffer, 0, read)
                    if (out.size() > limit) throw IOException("视频片段超出大小限制")
                }
                out.toByteArray()
            }
            return bytes
        }
    }

    class MediaDeniedException(code: Int) : IOException("回放服务拒绝访问（HTTP $code）")
}
