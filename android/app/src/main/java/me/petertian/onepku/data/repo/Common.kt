package me.petertian.onepku.data.repo

import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager

/** 会话过期或未登录时，用已存密码和当前口令重登一次并重试。 */
suspend fun <T> withReauth(auth: AuthManager, service: Service, block: suspend () -> T): T =
    auth.withRefresh(service, block)

/** 简单的内存缓存条目。 */
class CacheEntry<T>(val data: T, val at: Long = System.currentTimeMillis()) {
    fun fresh(ttlMs: Long) = System.currentTimeMillis() - at < ttlMs
}
