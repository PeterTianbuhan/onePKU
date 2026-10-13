package me.petertian.onepku.data.repo

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import me.petertian.onepku.data.treehole.ScopeOverride
import me.petertian.onepku.data.treehole.ScoreEntry
import me.petertian.onepku.data.treehole.isMajorRequired
import java.security.MessageDigest
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 专业课口径的本机手动调整记录。部分专业课在学校系统里被标成"任选",
 * 只按课程类别自动统计会漏,所以允许逐门加入或移出。只存本机。
 */
@Singleton
class GradeScopeStore @Inject constructor(
    @ApplicationContext context: Context,
    private val sessions: SessionStore,
) {
    private val prefs = context.getSharedPreferences("grades_scope", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(load())
    val state: StateFlow<ScopeOverride> = _state.asStateFlow()

    fun reload() {
        _state.value = load()
    }

    private fun uid(): String = sessions.session(Service.TREEHOLE)?.uid?.trim().orEmpty()

    private fun scoped(suffix: String): String {
        val uid = uid()
        if (uid.isEmpty()) return "logged-out:$suffix"
        val hash = MessageDigest.getInstance("SHA-256").digest(uid.toByteArray())
            .joinToString("") { "%02x".format(it) }
        return "$hash:$suffix"
    }

    private fun load(): ScopeOverride {
        migrateLegacy()
        return ScopeOverride(
            included = prefs.getStringSet(scoped(KEY_INCLUDED), emptySet()) ?: emptySet(),
            excluded = prefs.getStringSet(scoped(KEY_EXCLUDED), emptySet()) ?: emptySet(),
        )
    }

    /** 升级前的全局记录归到当前树洞账号，避免下一个账号继承上一账号的手动口径。 */
    private fun migrateLegacy() {
        if (uid().isEmpty()) return
        if (prefs.contains(scoped(KEY_INCLUDED)) || prefs.contains(scoped(KEY_EXCLUDED))) return
        if (!prefs.contains(KEY_INCLUDED) && !prefs.contains(KEY_EXCLUDED)) return
        prefs.edit()
            .putStringSet(scoped(KEY_INCLUDED), prefs.getStringSet(KEY_INCLUDED, emptySet()))
            .putStringSet(scoped(KEY_EXCLUDED), prefs.getStringSet(KEY_EXCLUDED, emptySet()))
            .remove(KEY_INCLUDED)
            .remove(KEY_EXCLUDED)
            .apply()
    }

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
            .putStringSet(scoped(KEY_INCLUDED), value.included)
            .putStringSet(scoped(KEY_EXCLUDED), value.excluded)
            .apply()
        _state.value = value
    }

    private companion object {
        const val KEY_INCLUDED = "included"
        const val KEY_EXCLUDED = "excluded"
    }
}
