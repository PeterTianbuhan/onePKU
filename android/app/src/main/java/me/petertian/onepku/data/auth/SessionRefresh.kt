package me.petertian.onepku.data.auth

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import me.petertian.onepku.core.network.SessionExpiredException
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException

/** 会话还剩这么久就提前续，避免正用着过期。 */
const val RENEW_HORIZON_SEC = 15 * 60L

/** 没有到期时间（课堂实录）时不提前登；到期或进入窗口才续。 */
fun sessionNeedsRenew(expiresAt: Long?, nowSec: Long, horizonSec: Long = RENEW_HORIZON_SEC): Boolean {
    if (expiresAt == null) return false
    return expiresAt <= nowSec + horizonSec
}

/**
 * 一次请求发现未登录时，重登一次再重试这一次。
 * 同一次失败里不会连着重登。重登失败或重试仍未登录，则在 [backoffMs] 内不再登。
 * 同一个服务并发的失效只登一次。
 */
class SessionRefresh(
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val backoffMs: Long = 60_000L,
    private val loginTimeoutMs: Long = 65_000L,
) {
    private class Gate {
        val mutex = Mutex()
        @Volatile var epoch: Int = 0
        @Volatile var blockedUntil: Long = 0L
    }

    private val gates = ConcurrentHashMap<String, Gate>()

    suspend fun <T> run(service: String, relogin: suspend () -> Unit, block: suspend () -> T): T {
        val gate = gates.getOrPut(service) { Gate() }
        val seen = gate.epoch
        try {
            return block()
        } catch (expired: SessionExpiredException) {
            gate.mutex.withLock {
                val now = nowMs()
                if (now < gate.blockedUntil) throw expired
                if (gate.epoch != seen) return@withLock
                try {
                    withTimeout(loginTimeoutMs) { relogin() }
                } catch (cancel: CancellationException) {
                    if (cancel !is TimeoutCancellationException) throw cancel
                    gate.blockedUntil = now + backoffMs
                    throw SessionExpiredException("重新登录超时")
                } catch (error: Exception) {
                    gate.blockedUntil = now + backoffMs
                    throw error
                }
                gate.epoch += 1
                gate.blockedUntil = 0L
            }
            try {
                return block()
            } catch (again: SessionExpiredException) {
                gate.mutex.withLock { gate.blockedUntil = nowMs() + backoffMs }
                throw again
            }
        }
    }

    /** 用户自己登录成功后，失败冷却作废。不动代际，避免把正在进行的重登再跑一遍。 */
    fun clear(service: String) {
        gates[service]?.blockedUntil = 0L
    }

    fun clearAll() {
        gates.values.forEach { it.blockedUntil = 0L }
    }
}
