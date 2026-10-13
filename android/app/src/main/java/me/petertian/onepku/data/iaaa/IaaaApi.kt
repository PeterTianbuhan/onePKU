package me.petertian.onepku.data.iaaa

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.Ua
import okhttp3.FormBody
import okhttp3.Request
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.inject.Inject

class IaaaException(message: String) : Exception(message)

/** PKU IAAA 统一身份认证(密码登录,RSA 加密)。 */
class IaaaApi @Inject constructor(private val httpFactory: HttpFactory) {

    private val json = Json { ignoreUnknownKeys = true }

    @Serializable
    private data class PublicKeyResp(val success: Boolean = false, val key: String? = null)

    @Serializable
    private data class LoginError(val code: String? = null, val msg: String? = null)

    @Serializable
    private data class LoginResp(val success: Boolean = false, val token: String? = null, val errors: LoginError? = null)

    /**
     * @return iaaa_token
     * @param mobileUa 校园卡链路要求移动端 UA + PKUAndroid 头
     */
    suspend fun login(
        appId: String,
        redirectUrl: String,
        username: String,
        password: String,
        otpCode: String? = null,
        mobileUa: Boolean = false,
    ): String = withContext(Dispatchers.IO) {
        val client = httpFactory.client(
            ua = if (mobileUa) Ua.MOBILE_CARD else Ua.DESKTOP,
            headers = if (mobileUa) mapOf("x-requested-with" to "cn.edu.pku.PKUAndroid") else emptyMap(),
        )

        // 1. RSA 公钥
        val pkResp = client.newCall(
            Request.Builder()
                .url("$IAAA_BASE/getPublicKey.do")
                .header("x-requested-with", "XMLHttpRequest")
                .header("referer", "$IAAA_BASE/oauth.jsp")
                .build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) throw IaaaException("获取公钥失败: HTTP ${resp.code}")
            json.decodeFromString(PublicKeyResp.serializer(), resp.requireBody().string())
        }
        val pem = pkResp.key ?: throw IaaaException("获取公钥失败")

        // 2. RSA PKCS#1 v1.5 加密密码
        val encrypted = encryptPassword(pem, password)

        // 3. 登录
        val form = FormBody.Builder()
            .add("appid", appId)
            .add("userName", username)
            .add("password", encrypted)
            .add("randCode", "")
            .add("smsCode", "")
            .add("otpCode", otpCode ?: "")
            .add("redirUrl", redirectUrl)
            .build()
        val loginResp = client.newCall(
            Request.Builder()
                .url("$IAAA_BASE/oauthlogin.do")
                .header("x-requested-with", "XMLHttpRequest")
                .header("referer", "$IAAA_BASE/oauth.jsp")
                .post(form)
                .build()
        ).execute().use { resp ->
            if (!resp.isSuccessful) throw IaaaException("登录请求失败: HTTP ${resp.code}")
            json.decodeFromString(LoginResp.serializer(), resp.requireBody().string())
        }

        if (loginResp.success && loginResp.token != null) {
            loginResp.token
        } else {
            val err = loginResp.errors
            throw IaaaException("登录失败: ${err?.msg ?: "未知错误"}${err?.code?.let { " ($it)" } ?: ""}")
        }
    }

    private fun encryptPassword(pem: String, password: String): String {
        val body = pem
            .replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
            .replace("\\s".toRegex(), "")
        val keySpec = X509EncodedKeySpec(Base64.getDecoder().decode(body))
        val publicKey = KeyFactory.getInstance("RSA").generatePublic(keySpec)
        val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
        cipher.init(Cipher.ENCRYPT_MODE, publicKey)
        return Base64.getEncoder().encodeToString(cipher.doFinal(password.toByteArray(Charsets.UTF_8)))
    }

    companion object {
        const val IAAA_BASE = "https://iaaa.pku.edu.cn/iaaa"
    }
}
