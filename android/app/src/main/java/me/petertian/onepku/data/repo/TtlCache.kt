package me.petertian.onepku.data.repo

/** 单用户内存缓存。退出或会话过期都不清掉已有内容。 */
class TtlCache<K, V>(
    private val ttlMs: Long,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private data class Entry<V>(val value: V, val at: Long)
    private val values = mutableMapOf<K, Entry<V>>()

    @Synchronized
    fun peek(key: K): V? =
        values[key]?.takeIf { clock() - it.at in 0 until ttlMs }?.value

    @Synchronized
    private fun put(key: K, value: V) {
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
        if (!force) peek(key)?.let { return it }
        val value = load() // 失败不写入缓存，下次可以立刻重试。
        put(key, value)
        return value
    }
}
