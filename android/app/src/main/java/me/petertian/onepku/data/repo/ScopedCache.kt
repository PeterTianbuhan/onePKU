package me.petertian.onepku.data.repo

/** 换账号或退出登录后，旧的在途结果不能写进新账号的缓存。 */
class AccountChangedException : IllegalStateException("账号已变化，请刷新后重试")

class ScopedCache<K, V>(
    private val scope: () -> String,
    private val ttlMs: Long,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private data class Entry<V>(val value: V, val at: Long)
    private val values = mutableMapOf<K, Entry<V>>()
    private var currentScope: String? = null

    @Synchronized
    private fun cached(key: K, expected: String, force: Boolean): V? {
        if (currentScope != expected) {
            values.clear()
            currentScope = expected
        }
        return values[key]?.takeIf { !force && clock() - it.at in 0 until ttlMs }?.value
    }

    @Synchronized
    private fun put(key: K, expected: String, value: V) {
        if (scope() != expected) throw AccountChangedException()
        if (currentScope != expected) {
            values.clear()
            currentScope = expected
        }
        values[key] = Entry(value, clock())
    }

    @Synchronized
    fun invalidate() {
        values.clear()
    }

    @Synchronized
    fun remove(key: K) {
        values.remove(key)
    }

    suspend fun get(key: K, force: Boolean = false, load: suspend () -> V): V {
        val expected = scope()
        cached(key, expected, force)?.let {
            if (scope() != expected) throw AccountChangedException()
            return it
        }
        val value = load() // 失败不写入缓存，下次可以立刻重试。
        put(key, expected, value)
        return value
    }
}
