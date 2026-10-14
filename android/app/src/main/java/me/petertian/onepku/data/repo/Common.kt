package me.petertian.onepku.data.repo

import me.petertian.onepku.core.network.NeedsLoginException
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager

/** 会话过期时自动重登一次并重试。失败就停，不再后台循环。 */
suspend fun <T> withReauth(auth: AuthManager, service: Service, block: suspend () -> T): T {
    return try {
        block()
    } catch (e: SessionExpiredException) {
        if (!auth.hasCredentials()) {
            throw NeedsLoginException(auth.loggedOutPrompt())
        }
        auth.relogin(service)
        try {
            block()
        } catch (again: SessionExpiredException) {
            auth.stopRelogin(service)
            throw NeedsLoginException(auth.loggedOutPrompt())
        }
    }
}

/** 简单的内存缓存条目。 */
class CacheEntry<T>(val data: T, val at: Long = System.currentTimeMillis()) {
    fun fresh(ttlMs: Long) = System.currentTimeMillis() - at < ttlMs
}
