package me.petertian.onepku.ui.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.auth.Totp
import javax.inject.Inject

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val auth: AuthManager,
) : ViewModel() {

    private val _ui = MutableStateFlow(LoginUiState())
    val ui: StateFlow<LoginUiState> = _ui.asStateFlow()

    init {
        auth.storedUsername()?.let { name -> _ui.update { it.copy(username = name) } }
    }

    fun setUsername(v: String) = _ui.update { it.copy(username = v.trim()) }
    fun setPassword(v: String) = _ui.update { it.copy(password = v) }
    fun setOtp(v: String) = _ui.update { it.copy(otp = v.trim()) }

    fun login(onDone: () -> Unit) {
        val state = _ui.value
        if (state.loggingIn) return
        val typed = state.otp.trim()
        val code = when {
            typed.isEmpty() -> null
            typed.length in 6..8 && typed.all { it.isDigit() } -> typed
            Totp.parseSecret(typed) != null -> {
                val error = auth.saveAutoLogin(state.username, state.password, typed)
                if (error != null) {
                    _ui.update { it.copy(results = listOf(ServiceLoginResult(Service.COURSE, false, error))) }
                    return
                }
                null
            }
            else -> {
                _ui.update {
                    it.copy(results = listOf(ServiceLoginResult(Service.COURSE, false, "动态口令是 6 位数字，密钥请填在设置里")))
                }
                return
            }
        }
        _ui.update { it.copy(loggingIn = true, results = emptyList(), otp = if (code == null) "" else it.otp) }
        viewModelScope.launch {
            val results = mutableListOf<ServiceLoginResult>()
            for (service in Service.entries) {
                val result = try {
                    auth.login(service, state.username, state.password, code)
                    ServiceLoginResult(service, true, null)
                } catch (e: Exception) {
                    ServiceLoginResult(service, false, e.message ?: "登录失败")
                }
                results.add(result)
                _ui.update { it.copy(results = results.toList()) }
            }
            _ui.update { it.copy(loggingIn = false) }
            if (results.any { it.ok }) onDone()
        }
    }
}
