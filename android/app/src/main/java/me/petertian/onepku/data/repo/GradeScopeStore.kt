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
 * 专业课口径的本机手动调整记录。单用户只存一份，退出登录不换桶。
 */
@Singleton
class GradeScopeStore @Inject constructor(@ApplicationContext context: Context) {
    private val prefs = context.getSharedPreferences("grades_scope", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(load())
    val state: StateFlow<ScopeOverride> = _state.asStateFlow()

    fun reload() {
        _state.value = load()
    }

    private fun load(): ScopeOverride {
        adoptHashedBack()
        return ScopeOverride(
            included = prefs.getStringSet(KEY_INCLUDED, emptySet()) ?: emptySet(),
            excluded = prefs.getStringSet(KEY_EXCLUDED, emptySet()) ?: emptySet(),
        )
    }

    /** 以前按账号分桶的记录，在还没有全局键时收回到这一份。 */
    private fun adoptHashedBack() {
        if (prefs.contains(KEY_INCLUDED) || prefs.contains(KEY_EXCLUDED)) return
        val includedKey = prefs.all.keys.firstOrNull { it.endsWith(":included") && !it.startsWith("logged-out:") }
        val excludedKey = prefs.all.keys.firstOrNull { it.endsWith(":excluded") && !it.startsWith("logged-out:") }
        if (includedKey == null && excludedKey == null) return
        prefs.edit()
            .putStringSet(KEY_INCLUDED, includedKey?.let { prefs.getStringSet(it, emptySet()) } ?: emptySet())
            .putStringSet(KEY_EXCLUDED, excludedKey?.let { prefs.getStringSet(it, emptySet()) } ?: emptySet())
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
            .putStringSet(KEY_INCLUDED, value.included)
            .putStringSet(KEY_EXCLUDED, value.excluded)
            .apply()
        _state.value = value
    }

    private companion object {
        const val KEY_INCLUDED = "included"
        const val KEY_EXCLUDED = "excluded"
    }
}
