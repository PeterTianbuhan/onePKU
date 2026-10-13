package me.petertian.onepku.core.session

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

enum class Service(val key: String, val displayName: String) {
    COURSE("course", "教学网"),
    TREEHOLE("treehole", "树洞"),
    CARD("campuscard", "校园卡"),
    PORTAL("portal", "校内门户"),
}

@Serializable
data class StoredSession(
    val token: String,
    val expiresAt: Long? = null,
    val uid: String? = null,
    val extra: Map<String, String> = emptyMap(),
) {
    fun isExpired(nowSec: Long = System.currentTimeMillis() / 1000): Boolean =
        expiresAt != null && expiresAt <= nowSec
}

data class Credentials(val username: String, val password: String)

/**
 * 凭证与各服务会话的加密存储(Keystore 加密的 SharedPreferences)。
 * 保存密码是为了会话过期后自动重登;绝不外传。
 */
@Singleton
class SessionStore @Inject constructor(@ApplicationContext context: Context) {

    private val json = Json { ignoreUnknownKeys = true }

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "onepku_secure",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun saveCredentials(c: Credentials) {
        prefs.edit().putString("cred_username", c.username).putString("cred_password", c.password).apply()
    }

    fun credentials(): Credentials? {
        val u = prefs.getString("cred_username", null) ?: return null
        val p = prefs.getString("cred_password", null) ?: return null
        return Credentials(u, p)
    }

    fun saveSession(service: Service, session: StoredSession) {
        prefs.edit().putString("session_${service.key}", json.encodeToString(StoredSession.serializer(), session)).apply()
    }

    fun session(service: Service): StoredSession? {
        val raw = prefs.getString("session_${service.key}", null) ?: return null
        return runCatching { json.decodeFromString(StoredSession.serializer(), raw) }.getOrNull()
    }

    fun isLoggedIn(service: Service): Boolean {
        val s = session(service) ?: return false
        return !s.isExpired()
    }

    fun clear(service: Service) {
        prefs.edit().remove("session_${service.key}").apply()
    }

    fun clearAll() {
        prefs.edit().clear().apply()
    }
}
