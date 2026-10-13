package me.petertian.onepku.data.repo

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 本院通知使用的院系:优先用户手动选择,其次门户「单位」。
 * 只存本机。
 */
@Singleton
class DepartmentStore @Inject constructor(
    @ApplicationContext context: Context,
    private val sessionStore: SessionStore,
) {
    private val prefs = context.getSharedPreferences("school_scope", Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(read())
    val state: StateFlow<String?> = _state.asStateFlow()

    fun current(): String? = _state.value

    fun select(school: String?) {
        prefs.edit().apply { if (school == null) remove(KEY_MANUAL) else putString(KEY_MANUAL, school) }.apply()
        _state.value = read()
    }

    /** 登录门户成功后缓存学校返回的「单位」。 */
    fun cacheDetected(department: String) {
        if (department.isNotBlank()) {
            prefs.edit().putString(KEY_DETECTED, department).apply()
            _state.value = read()
        }
    }

    private fun read(): String? =
        prefs.getString(KEY_MANUAL, null)
            ?: sessionStore.session(Service.PORTAL)?.extra?.get("department")?.takeIf { it.isNotBlank() }
            ?: prefs.getString(KEY_DETECTED, null)

    private companion object {
        const val KEY_MANUAL = "manual"
        const val KEY_DETECTED = "detected"
    }
}
