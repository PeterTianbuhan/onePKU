package me.petertian.onepku.data.repo

import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager

/** 会话过期时用已存凭证自动重登一次并重试。 */
suspend fun <T> withReauth(auth: AuthManager, service: Service, block: suspend () -> T): T {
    val before = auth.cacheScope(service)
    return try {
        val result = block()
        if (auth.cacheScope(service) != before) throw AccountChangedException()
        result
    } catch (e: SessionExpiredException) {
        if (auth.cacheScope(service) != before) throw AccountChangedException()
        if (!auth.hasCredentials(service)) throw e
        auth.relogin(service)
        val restored = auth.cacheScope(service)
        val result = block()
        if (auth.cacheScope(service) != restored) throw AccountChangedException()
        result
    }
}

/** 简单的内存缓存条目。 */
class CacheEntry<T>(val data: T, val at: Long = System.currentTimeMillis()) {
    fun fresh(ttlMs: Long) = System.currentTimeMillis() - at < ttlMs
}
