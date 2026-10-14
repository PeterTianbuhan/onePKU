package me.petertian.onepku.data.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import me.petertian.onepku.core.network.CookieStores
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.NeedsLoginException
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.core.session.Credentials
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import me.petertian.onepku.core.session.StoredSession
import me.petertian.onepku.data.iaaa.IaaaApi
import me.petertian.onepku.data.iaaa.IaaaException
import me.petertian.onepku.data.portal.PortalApi
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.random.Random

/**
 * 各服务登录编排:IAAA 密码登录 → 服务 SSO 回调 → 保存会话。
 * 会话过期后用加密存储的凭证自动重登一次。
 */
@Singleton
class AuthManager @Inject constructor(
    private val iaaa: IaaaApi,
    private val httpFactory: HttpFactory,
    private val sessionStore: SessionStore,
    private val cookieStores: CookieStores,
    private val portal: PortalApi,
) {
    private val reloginGate = ReloginGate()

    fun isLoggedIn(service: Service): Boolean = sessionStore.isLoggedIn(service)

    fun loggedInServices(): Set<Service> = Service.entries.filter { isLoggedIn(it) }.toSet()

    fun hasCredentials(): Boolean = sessionStore.credentials() != null

    fun storedUsername(): String? = sessionStore.credentials()?.username

    fun otpStored(): Boolean = sessionStore.otpStored()

    fun stopRelogin(service: Service) {
        reloginGate.noteFailure(service.key)
    }

    /**
     * 密码只在某个服务登录成功之后才写入加密存储。
     * `otpSecret` 为 null 表示沿用已保存的密钥；空字符串表示成功后清除。
     */
    suspend fun login(
        service: Service,
        username: String,
        password: String,
        otpCode: String? = null,
        otpSecret: String? = null,
        remember: Boolean = true,
    ) {
        val (user, pass) = resolveIdentity(username, password)
        val code = otpFor(otpCode, otpSecret)
        try {
            when (service) {
                Service.COURSE -> loginCourse(user, pass, code)
                Service.TREEHOLE -> loginTreehole(user, pass, code)
                Service.CARD -> loginCard(user, pass, code)
                Service.PORTAL -> loginPortal(user, pass, code)
            }
        } catch (e: Exception) {
            sessionStore.clear(service)
            throw e
        }
        reloginGate.noteSuccess(service.key)
        if (remember) {
            sessionStore.saveCredentials(Credentials(user, pass))
            when {
                otpSecret == null -> Unit
                otpSecret.isBlank() -> sessionStore.clearOtpSecret()
                else -> sessionStore.saveOtpSecret(otpSecret.filter { !it.isWhitespace() })
            }
        }
    }

    /**
     * 用已存凭证重登一次。同时只跑一个；失败后停止，直到手动登录成功。
     * 不改钥匙串里的账号、密码和密钥。
     */
    suspend fun relogin(service: Service, manual: Boolean = false) {
        if (!manual && reloginGate.isStopped(service.key)) throw NeedsLoginException(loggedOutPrompt())
        val seen = reloginGate.seen(service.key)
        val lock = reloginGate.lock(service.key)
        lock.lock()
        try {
            if (!manual && reloginGate.isStopped(service.key)) throw NeedsLoginException(loggedOutPrompt())
            if (reloginGate.peerRefreshed(service.key, seen) && isLoggedIn(service)) return
            try {
                val cred = sessionStore.credentials()
                    ?: throw NeedsLoginException("没有保存的账号，请重新登录")
                login(service, cred.username, cred.password, remember = false)
            } catch (e: NeedsLoginException) {
                reloginGate.noteFailure(service.key)
                throw e
            } catch (e: Exception) {
                reloginGate.noteFailure(service.key)
                throw NeedsLoginException(loggedOutPrompt())
            }
        } finally {
            lock.unlock()
        }
    }

    private fun resolveIdentity(username: String, password: String): Pair<String, String> {
        val stored = sessionStore.credentials()
        val user = username.trim().ifEmpty { stored?.username.orEmpty() }
        val pass = password.ifEmpty { stored?.password.orEmpty() }
        if (user.isEmpty() || pass.isEmpty()) throw IllegalArgumentException("请填写校园账号与密码")
        return user to pass
    }

    private fun otpFor(explicit: String?, replacement: String?): String? {
        if (!explicit.isNullOrBlank()) return explicit.trim()
        val secret = when {
            replacement == null -> sessionStore.otpSecret()
            replacement.isBlank() -> null
            else -> replacement.filter { !it.isWhitespace() }
        } ?: return null
        return Totp.generate(secret)
    }

    fun loggedOutPrompt(): String = if (sessionStore.otpStored()) {
        "自动重新登录没有成功，请重新登录"
    } else {
        "登录已失效。若学校要求手机令牌，请先在设置里保存密钥，再重新登录"
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

    private fun nowSec() = System.currentTimeMillis() / 1000

    /** Rust 端 {f64:.20} 的等价物;固定 US locale 避免小数点被本地化。 */
    private fun rand20() = "%.20f".format(java.util.Locale.US, Random.nextDouble())
}
