package me.petertian.onepku.data.repo

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.petertian.onepku.data.treehole.ScopeOverride
import me.petertian.onepku.data.treehole.ScoreEntry
import me.petertian.onepku.data.treehole.isMajorRequired
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 专业课口径的本机手动调整记录。部分专业课在学校系统里被标成"任选",
 * 只按课程类别自动统计会漏,所以允许逐门加入或移出。只存本机。
 */
@Singleton
class GradeScopeStore @Inject constructor(@ApplicationContext context: Context, private val sessions: me.petertian.onepku.core.session.SessionStore) {
    private val prefs = context.getSharedPreferences("grades_scope", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(load())
    val state: StateFlow<ScopeOverride> = _state.asStateFlow()

    private fun key(suffix: String): String {
        val uid = sessions.session(me.petertian.onepku.core.session.Service.TREEHOLE)?.uid.orEmpty()
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(uid.toByteArray()).joinToString("") { "%02x".format(it) }
        return "$hash:$suffix"
    }
    fun reload() { _state.value = load() }

    private fun load(): ScopeOverride = ScopeOverride(
        included = prefs.getStringSet(key(KEY_INCLUDED), emptySet()) ?: emptySet(),
        excluded = prefs.getStringSet(key(KEY_EXCLUDED), emptySet()) ?: emptySet(),
    )

    fun setIncluded(entry: ScoreEntry, want: Boolean) {
        val current = load()
        val included = current.included.toMutableSet()
        val excluded = current.excluded.toMutableSet()
        if (want) {
            excluded.remove(entry.scopeKey)
            if (!entry.isMajorRequired()) included.add(entry.scopeKey)
        } else {
            included.remove(entry.scopeKey)
            if (entry.isMajorRequired()) excluded.add(entry.scopeKey)
        }
        save(ScopeOverride(included, excluded))
    }

    fun reset() = save(ScopeOverride())

    private fun save(value: ScopeOverride) {
        prefs.edit()
            .putStringSet(key(KEY_INCLUDED), value.included)
            .putStringSet(key(KEY_EXCLUDED), value.excluded)
            .apply()
        _state.value = value
    }

    private companion object {
        const val KEY_INCLUDED = "included"
        const val KEY_EXCLUDED = "excluded"
    }
}
