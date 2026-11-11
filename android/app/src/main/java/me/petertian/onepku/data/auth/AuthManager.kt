package me.petertian.onepku.data.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import me.petertian.onepku.core.network.CookieStores
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.core.session.Credentials
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import me.petertian.onepku.core.session.StoredSession
import me.petertian.onepku.data.iaaa.IaaaApi
import me.petertian.onepku.data.iaaa.IaaaException
import me.petertian.onepku.data.portal.PortalApi
import me.petertian.onepku.data.replay.Haoxue
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.random.Random

/**
 * 各服务登录编排:IAAA 密码登录 → 服务 SSO 回调 → 保存会话。
 * 会话过期后用加密存储的密码和当前手机令牌重登一次。
 */
@Singleton
class AuthManager @Inject constructor(
    private val iaaa: IaaaApi,
    private val httpFactory: HttpFactory,
    private val sessionStore: SessionStore,
    private val cookieStores: CookieStores,
    private val portal: PortalApi,
) {
    private val sessionRefresh = SessionRefresh()
    private val renewScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val renewStarted = AtomicBoolean(false)

    fun isLoggedIn(service: Service): Boolean = sessionStore.isLoggedIn(service)

    fun loggedInServices(): Set<Service> = Service.entries.filter { isLoggedIn(it) }.toSet()

    fun hasCredentials(): Boolean = sessionStore.credentials() != null

    fun cacheScope(service: Service): String = sessionStore.cacheScope(service)

    fun sessionUid(service: Service): String = sessionStore.session(service)?.uid?.trim().orEmpty()

    fun storedUsername(): String? = sessionStore.username()

    fun otpSaved(): Boolean = sessionStore.otpSecret() != null

    /** 用草稿或已保存的密钥算出当前 6 位口令，供设置页对照。算不出就返回 null。 */
    fun previewCode(draft: String, nowMs: Long = System.currentTimeMillis()): String? {
        val secret = if (draft.isNotBlank()) {
            Totp.parseSecret(draft) ?: return null
        } else {
            sessionStore.otpSecret() ?: return null
        }
        return runCatching { Totp.current(secret, nowMs) }.getOrNull()
    }

    /**
     * 保存自动登录用的密码和手机令牌。密钥留空表示不改已保存的；没有就保持不使用。
     * 返回 null 表示已保存，否则是给人看的错误，不含密钥本身。
     */
    fun saveAutoLogin(username: String, password: String, secretDraft: String): String? {
        val name = username.trim()
        if (name.isEmpty()) return "请填写学号"
        val parsed = if (secretDraft.isBlank()) {
            null
        } else {
            Totp.parseSecret(secretDraft) ?: return "手机令牌无法识别，请粘贴 otpauth:// 链接或 Base32 密钥"
        }
        val existing = sessionStore.credentials()
        val pass = if (password.isNotEmpty()) password else existing?.takeIf { it.username == name }?.password
        if (pass.isNullOrEmpty()) return "请填写统一身份认证密码"
        val previousName = sessionStore.username()
        sessionStore.saveCredentials(Credentials(name, pass))
        if (parsed != null) {
            sessionStore.saveOtpSecret(parsed)
        } else if (previousName != null && previousName != name) {
            sessionStore.saveOtpSecret(null)
        }
        sessionRefresh.clearAll()
        return null
    }

    fun clearAutoLogin() {
        sessionStore.clearPasswordAndOtp()
        sessionRefresh.clearAll()
    }

    /** 启动时把已过期或快过期、并且本机还有会话的服务各续一次。没会话的不主动连回去。 */
    fun renewStaleSessions() {
        if (!renewStarted.compareAndSet(false, true)) return
        renewScope.launch {
            if (!hasCredentials()) return@launch
            val now = System.currentTimeMillis() / 1000
            for (service in Service.entries) {
                val session = sessionStore.session(service) ?: continue
                if (!sessionNeedsRenew(session.expiresAt, now)) continue
                runCatching {
                    withRefresh(service) {
                        val current = sessionStore.session(service)
                        val t = System.currentTimeMillis() / 1000
                        if (current == null || sessionNeedsRenew(current.expiresAt, t)) {
                            throw SessionExpiredException()
                        }
                    }
                }
            }
        }
    }

    suspend fun login(service: Service, username: String, password: String, otpCode: String? = null) {
        openSession(service, username, password, otpCode, wipeOnFailure = true)
    }

    /**
     * 用已存密码和当前口令重登。无密码时抛 SessionExpiredException。不把密钥写进异常。
     * 失败时留下原来的会话：网络抖一下不该把还能用的登录清掉。
     */
    suspend fun relogin(service: Service) {
        val cred = sessionStore.credentials()
            ?: throw SessionExpiredException("请先登录")
        openSession(service, cred.username, cred.password, null, wipeOnFailure = false)
    }

    private suspend fun openSession(
        service: Service,
        username: String,
        password: String,
        otpCode: String?,
        wipeOnFailure: Boolean,
    ) {
        sessionStore.saveCredentials(Credentials(username, password))
        val code = otpCode?.trim()?.takeIf { it.isNotEmpty() } ?: currentOtp()
        try {
            when (service) {
                Service.COURSE -> loginCourse(username, password, code)
                Service.TREEHOLE -> loginTreehole(username, password, code)
                Service.CARD -> loginCard(username, password, code)
                Service.PORTAL -> loginPortal(username, password, code)
                Service.HAOXUE -> loginHaoxue(username, password, code)
            }
            sessionRefresh.clear(service.key)
        } catch (e: Exception) {
            if (wipeOnFailure) sessionStore.clear(service)
            throw e
        }
    }

    /**
     * 请求发现未登录时重登一次再试一次。没有保存密码就原样抛出。
     * 重登失败或重试仍未登录之后会冷却，避免连着打 IAAA。
     */
    suspend fun <T> withRefresh(service: Service, block: suspend () -> T): T {
        if (!hasCredentials()) return block()
        return sessionRefresh.run(service.key, { relogin(service) }, block)
    }

    private fun currentOtp(): String? {
        val secret = sessionStore.otpSecret() ?: return null
        return try {
            Totp.current(secret)
        } catch (_: Exception) {
            throw IaaaException("已保存的手机令牌无法生成口令")
        }
    }

    fun logout(service: Service) {
        sessionStore.clear(service)
        cookieStores.clear(service.key)
    }

    fun logoutAll() {
        Service.entries.forEach { logout(it) }
        sessionStore.clearAll()
    }

    // ---- 教学网(Blackboard)----

    private suspend fun loginCourse(username: String, password: String, otpCode: String?) =
        withContext(Dispatchers.IO) {
            val token = iaaa.login(
                appId = "blackboard",
                redirectUrl = "http://course.pku.edu.cn/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin",
                username = username,
                password = password,
                otpCode = otpCode,
            )
            val jar = cookieStores.jar(Service.COURSE.key)
            jar.clear()
            val client = httpFactory.client(cookieJar = jar, ua = Ua.DESKTOP)
            val url = "https://course.pku.edu.cn/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin" +
                "?_rand=${rand20()}&token=$token"
            client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                val finalUrl = resp.request.url.toString()
                val body = resp.requireBody().string()
                if (finalUrl.contains("iaaa.pku.edu.cn") || body.contains("loginForm") || body.contains("id=\"loginBox\"")) {
                    throw IaaaException("教学网会话建立失败")
                }
            }
            sessionStore.saveSession(
                Service.COURSE,
                StoredSession(token = token, expiresAt = nowSec() + 24 * 3600, uid = username),
            )
        }

    // ---- 树洞 ----

    private suspend fun loginTreehole(username: String, password: String, otpCode: String?) =
        withContext(Dispatchers.IO) {
            val old = sessionStore.session(Service.TREEHOLE)
            val deviceUuid = old?.extra?.get("device_uuid") ?: run {
                UUID.randomUUID().toString().replace("-", "").takeLast(12)
            }
            val fullUuid = old?.extra?.get("full_uuid") ?: run {
                val full = UUID.randomUUID().toString()
                "Web_PKUHOLE_2.0.0_WEB_UUID_${full.substring(0, 23)}-$deviceUuid"
            }

            val redirect = "https://treehole.pku.edu.cn/chapi/cas_iaaa_login?version=3&uuid=$deviceUuid&plat=web"
            val iaaaToken = iaaa.login("PKU Helper", redirect, username, password, otpCode)

            val jar = cookieStores.jar(Service.TREEHOLE.key)
            jar.clear()
            val client = httpFactory.client(cookieJar = jar, followRedirects = false, ua = Ua.DESKTOP)
            val callbackUrl = "$redirect&_rand=${Random.nextDouble()}&token=$iaaaToken"
            val resp = client.newCall(Request.Builder().url(callbackUrl).build()).execute()
            val (jwt, expiresIn, uid) = resp.use {
                if (it.isRedirect) {
                    val location = it.header("location") ?: throw IaaaException("树洞回调缺少 location")
                    parseTreeholeCallback(location)
                } else {
                    it.requireBody().string()
                    val token = jar.cookieValue("pku_token") ?: throw IaaaException("树洞回调未返回 token")
                    val exp = jar.cookieValue("pku_expires_in")?.toLongOrNull() ?: (nowSec() + 7 * 24 * 3600)
                    Triple(token, exp, jar.cookieValue("pku_uid") ?: username)
                }
            }

            // 刷新 cookies(失败不阻塞)
            runCatching {
                client.newCall(
                    Request.Builder()
                        .url("https://treehole.pku.edu.cn/chapi/version?t=${System.currentTimeMillis()}")
                        .header("authorization", "Bearer $jwt")
                        .header("uuid", fullUuid)
                        .build()
                ).execute().close()
            }

            sessionStore.saveSession(
                Service.TREEHOLE,
                StoredSession(
                    token = jwt,
                    expiresAt = expiresIn,
                    uid = uid,
                    extra = mapOf("device_uuid" to deviceUuid, "full_uuid" to fullUuid),
                ),
            )
        }

    private fun parseTreeholeCallback(location: String): Triple<String, Long, String> {
        val url = if (location.startsWith("http")) location.toHttpUrl()
        else "https://treehole.pku.edu.cn$location".toHttpUrl()
        val token = url.queryParameter("token") ?: throw IaaaException("树洞回调缺少 token")
        val expiresIn = url.queryParameter("expires_in")?.toLongOrNull() ?: (nowSec() + 7 * 24 * 3600)
        val uid = url.queryParameter("uid") ?: ""
        return Triple(token, expiresIn, uid)
    }

    // ---- 校园卡 ----

    private suspend fun loginCard(username: String, password: String, otpCode: String?) =
        withContext(Dispatchers.IO) {
            val iaaaToken = iaaa.login(
                appId = "portal2017",
                redirectUrl = "https://portal.pku.edu.cn/portal2017/ssoLogin.do",
                username = username,
                password = password,
                otpCode = otpCode,
                mobileUa = true,
            )

            val jar = cookieStores.jar(Service.CARD.key)
            jar.clear()
            val client = httpFactory.client(
                cookieJar = jar,
                followRedirects = false,
                ua = Ua.MOBILE_CARD,
                headers = mapOf("x-requested-with" to "cn.edu.pku.PKUAndroid"),
                http1Only = true,
            )

            // 1. 门户 SSO(种 SESSION cookie)
            val ssoUrl = "https://portal.pku.edu.cn/portal2017/ssoLogin.do" +
                "?_rand=${rand20()}&token=$iaaaToken"
            client.newCall(Request.Builder().url(ssoUrl).build()).execute().use {
                if (!it.isSuccessful && !it.isRedirect) throw IaaaException("门户 SSO 失败: HTTP ${it.code}")
                it.requireBody().string()
            }

            // 2. redirectToCard.do → 302
            val loc1 = client.newCall(
                Request.Builder().url("https://portal.pku.edu.cn/portal2017/util/redirectToCard.do").build()
            ).execute().use {
                it.requireBody().string()
                it.header("location") ?: throw IaaaException("redirectToCard 未重定向(HTTP ${it.code})")
            }

            // 3. berserker-auth → 302 带 synjones-auth
            val loc2 = client.newCall(Request.Builder().url(loc1).build()).execute().use {
                it.requireBody().string()
                it.header("location") ?: throw IaaaException("berserker-auth 未重定向(HTTP ${it.code})")
            }

            val jwt = loc2.toHttpUrl().queryParameter("synjones-auth")
                ?: throw IaaaException("未获取到校园卡凭证")

            sessionStore.saveSession(
                Service.CARD,
                StoredSession(token = jwt, expiresAt = nowSec() + 24 * 3600, uid = username),
            )
        }

    // ---- 校内门户(院系识别) ----

    private suspend fun loginPortal(username: String, password: String, otpCode: String?) =
        withContext(Dispatchers.IO) {
            val token = iaaa.login(
                appId = "portal2017",
                redirectUrl = "https://portal.pku.edu.cn/portal2017/ssoLogin.do",
                username = username,
                password = password,
                otpCode = otpCode,
            )
            val jar = cookieStores.jar(Service.PORTAL.key)
            jar.clear()
            val client = httpFactory.client(cookieJar = jar, ua = Ua.DESKTOP)
            client.newCall(
                Request.Builder()
                    .url("https://portal.pku.edu.cn/portal2017/ssoLogin.do?_rand=${rand20()}&token=$token")
                    .build()
            ).execute().use { it.requireBody().string() }

            // 先落会话,basicInfo 需要它;验证失败再清掉。
            sessionStore.saveSession(
                Service.PORTAL,
                StoredSession(token = token, expiresAt = nowSec() + 12 * 3600, uid = username),
            )
            try {
                val profile = portal.basicInfo()
                sessionStore.saveSession(
                    Service.PORTAL,
                    StoredSession(
                        token = token,
                        expiresAt = nowSec() + 12 * 3600,
                        uid = username,
                        extra = mapOf("department" to profile.department),
                    ),
                )
            } catch (e: Exception) {
                sessionStore.clear(Service.PORTAL)
                throw e
            }
        }

    // ---- 好学课堂实录 ----

    /**
     * 统一认证换课堂实录票据，再以好学安卓 WebView 的身份打开 app-login 中转页，
     * 页面源码里交给原生桥的那段载荷就是令牌。与桌面端 haoxue::login_password 同一条路。
     */
    private suspend fun loginHaoxue(username: String, password: String, otpCode: String?) =
        withContext(Dispatchers.IO) {
            val jar = cookieStores.jar(Service.HAOXUE.key)
            jar.clear()
            val client = httpFactory.client(cookieJar = jar, followRedirects = false, ua = Haoxue.ANDROID_UA)
            val passport = "https://passport.pku.edu.cn"
            passportGet(client, "$passport/auth/login?redirect=${java.net.URLEncoder.encode("$passport/auth/app-login", "UTF-8")}")
            val token = iaaa.login(
                appId = "resource",
                redirectUrl = passport,
                username = username,
                password = password,
                otpCode = otpCode,
            )
            // 回调地址带票据，失败时不把地址放进错误信息。
            runCatching { passportGet(client, "$passport/?token=$token") }
                .onFailure { throw IaaaException("课堂实录换票失败") }
            val html = passportGet(client, "$passport/auth/app-login")
            val payload = Haoxue.extractPayload(html)?.let(Haoxue::parsePayload)
                ?: throw IaaaException("课堂实录没有交出登录授权")
            if (payload.account.trim() != username.trim()) throw IaaaException("课堂实录返回的身份与当前账号不一致")
            sessionStore.saveSession(
                Service.HAOXUE,
                StoredSession(
                    token = payload.token,
                    uid = payload.account,
                    extra = mapOf("cookieToken" to payload.cookieToken, "realname" to payload.name),
                ),
            )
        }

    /** 只在 passport / iaaa 之间跟随跳转，最多 6 次；返回最后一页的正文。 */
    private fun passportGet(client: okhttp3.OkHttpClient, start: String): String {
        var url = start.toHttpUrl()
        repeat(7) {
            client.newCall(Request.Builder().url(url).header("Accept", "text/html").build()).execute().use { resp ->
                if (resp.isRedirect) {
                    val next = resp.header("location")?.let { url.resolve(it) }
                    if (next == null || !next.isHttps || next.host !in setOf("passport.pku.edu.cn", "iaaa.pku.edu.cn")) {
                        return ""
                    }
                    url = next
                    return@repeat
                }
                if (!resp.isSuccessful) throw IaaaException("课堂实录登录失败: HTTP ${resp.code}")
                return resp.requireBody().string()
            }
        }
        throw IaaaException("课堂实录登录跳转过多")
    }

    private fun nowSec() = System.currentTimeMillis() / 1000

    /** Rust 端 {f64:.20} 的等价物;固定 US locale 避免小数点被本地化。 */
    private fun rand20() = "%.20f".format(java.util.Locale.US, Random.nextDouble())
}
