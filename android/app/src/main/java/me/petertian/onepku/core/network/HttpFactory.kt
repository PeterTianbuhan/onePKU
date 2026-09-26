package me.petertian.onepku.core.network

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import me.petertian.onepku.R
import okhttp3.CookieJar
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

object Ua {
    const val DESKTOP =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
    const val MOBILE_CARD =
        "PKUANDROID2.2.0_SM-S938B Dalvik/2.1.0 (Linux; U; Android 15; SM-S938B Build/BP1A.250305.020) okhttp/4.12.0"
    const val NEWS = "OnePKU/0.2 (personal campus reader)"
}

/** 会话失效（被重定向回登录页 / 401），需要重新登录。 */
class SessionExpiredException(message: String = "登录会话已过期") : Exception(message)

/** 树洞要求短信验证（code 40002）。 */
class SmsVerificationRequiredException : Exception("树洞需要短信验证")

fun okhttp3.Response.requireBody(): okhttp3.ResponseBody =
    checkNotNull(body) { "空响应体" }

@Singleton
class HttpFactory @Inject constructor(@ApplicationContext private val context: Context) {

    private val ssl: Pair<javax.net.ssl.SSLSocketFactory, X509TrustManager> by lazy { buildSsl() }

    /**
     * course.pku.edu.cn 等站点发送了错误的中间证书，浏览器靠 AIA 补链，
     * OkHttp 需要把 GlobalSign AlphaSSL CA 2025 中间证书作为额外信任锚。
     */
    private fun buildSsl(): Pair<javax.net.ssl.SSLSocketFactory, X509TrustManager> {
        val defaultTm = TrustManagerFactory
            .getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(null as KeyStore?) }
            .trustManagers.filterIsInstance<X509TrustManager>().first()

        val extra = context.resources.openRawResource(R.raw.globalsign_alphassl_ca_2025).use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }

        val extraTm = TrustManagerFactory
            .getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply {
                init(KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                    load(null)
                    setCertificateEntry("alphassl2025", extra)
                })
            }
            .trustManagers.filterIsInstance<X509TrustManager>().first()

        val combined = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                defaultTm.checkClientTrusted(chain, authType)

            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                try {
                    defaultTm.checkServerTrusted(chain, authType)
                } catch (e: CertificateException) {
                    extraTm.checkServerTrusted(chain, authType)
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> =
                defaultTm.acceptedIssuers + extra
        }

        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(combined), null)
        return sslContext.socketFactory to combined
    }

    fun client(
        cookieJar: CookieJar? = null,
        followRedirects: Boolean = true,
        ua: String? = null,
        headers: Map<String, String> = emptyMap(),
        http1Only: Boolean = false,
        readTimeoutSec: Long = 30,
    ): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(readTimeoutSec, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .followRedirects(followRedirects)
            .followSslRedirects(followRedirects)
            .sslSocketFactory(ssl.first, ssl.second)
        if (http1Only) builder.protocols(listOf(Protocol.HTTP_1_1))
        if (cookieJar != null) builder.cookieJar(cookieJar)
        if (ua != null || headers.isNotEmpty()) {
            builder.addInterceptor(Interceptor { chain ->
                val req = chain.request().newBuilder().apply {
                    if (ua != null) header("User-Agent", ua)
                    headers.forEach { (k, v) -> header(k, v) }
                }.build()
                chain.proceed(req)
            })
        }
        return builder.build()
    }
}
