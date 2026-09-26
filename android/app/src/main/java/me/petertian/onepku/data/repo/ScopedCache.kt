package me.petertian.onepku.data.repo

/** A session change invalidates cached values and rejects an older in-flight response. */
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
        if (currentScope != expected) { values.clear(); currentScope = expected }
        return values[key]?.takeIf { !force && clock() - it.at in 0 until ttlMs }?.value
    }

    @Synchronized
    private fun put(key: K, expected: String, value: V) {
        if (scope() != expected) throw AccountChangedException()
        if (currentScope != expected) { values.clear(); currentScope = expected }
        values[key] = Entry(value, clock())
    }

    suspend fun get(key: K, force: Boolean = false, load: suspend () -> V): V {
        val expected = scope()
        cached(key, expected, force)?.let { if (scope() != expected) throw AccountChangedException(); return it }
        val value = load() // Failures are never cached as successful empty results.
        put(key, expected, value)
        return value
    }
}
