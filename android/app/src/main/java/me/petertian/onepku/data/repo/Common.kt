package me.petertian.onepku.data.repo

import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager

/** 会话过期时用已存凭证自动重登一次并重试。 */
suspend fun <T> withReauth(auth: AuthManager, service: Service, block: suspend () -> T): T {
    return try {
        block()
    } catch (e: SessionExpiredException) {
        if (!auth.hasCredentials()) throw e
        auth.relogin(service)
        block()
    }
}

/** 简单的内存缓存条目。 */
class CacheEntry<T>(val data: T, val at: Long = System.currentTimeMillis()) {
    fun fresh(ttlMs: Long) = System.currentTimeMillis() - at < ttlMs
}
