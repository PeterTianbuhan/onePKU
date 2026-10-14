package me.petertian.onepku.data.auth

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.sync.Mutex

/**
 * 每个服务同时只允许一次自动重登。失败后停住，直到手动登录成功。
 */
class ReloginGate {
    private val stopped = ConcurrentHashMap.newKeySet<String>()
    private val epoch = ConcurrentHashMap<String, Long>()
    private val locks = ConcurrentHashMap<String, Mutex>()

    fun isStopped(service: String): Boolean = service in stopped

    fun seen(service: String): Long = epoch[service] ?: 0L

    fun lock(service: String): Mutex = locks.getOrPut(service) { Mutex() }

    fun noteSuccess(service: String) {
        stopped.remove(service)
        epoch.merge(service, 1L, Long::plus)
    }

    fun noteFailure(service: String) {
        stopped.add(service)
    }

    /** 等锁期间如果别的请求已经换票成功，就不必再登一次。 */
    fun peerRefreshed(service: String, seen: Long): Boolean = (epoch[service] ?: 0L) != seen
}
