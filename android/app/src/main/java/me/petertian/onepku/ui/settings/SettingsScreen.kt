package me.petertian.onepku.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import me.petertian.onepku.BuildConfig
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.news.SchoolNoticeApi
import me.petertian.onepku.data.repo.DepartmentStore
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

data class SettingsUiState(
    val username: String? = null,
    val otpStored: Boolean = false,
    val accountDraft: String = "",
    val passwordDraft: String = "",
    val secretDraft: String = "",
    val clearSecret: Boolean = false,
    val savingLogin: Boolean = false,
    val services: Map<Service, Boolean> = emptyMap(),
    val department: String? = null,
    val schools: List<String> = emptyList(),
    val pickingSchool: Boolean = false,
    val busy: Boolean = false,
    val message: String? = null,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val auth: AuthManager,
    private val departments: DepartmentStore,
    schoolNotices: SchoolNoticeApi,
) : ViewModel() {

    private val _ui = MutableStateFlow(SettingsUiState(schools = schoolNotices.schools()))
    val ui: StateFlow<SettingsUiState> = _ui.asStateFlow()

    init { reload() }

    fun reload() {
        _ui.update {
            it.copy(
                username = auth.storedUsername(),
                otpStored = auth.otpStored(),
                services = Service.entries.associateWith { s -> auth.isLoggedIn(s) },
                department = departments.current(),
            )
        }
    }

    fun setAccount(value: String) = _ui.update { it.copy(accountDraft = value) }
    fun setPassword(value: String) = _ui.update { it.copy(passwordDraft = value) }
    fun setSecret(value: String) = _ui.update { it.copy(secretDraft = value) }
    fun setClearSecret(value: Boolean) = _ui.update { it.copy(clearSecret = value) }

    fun setPickingSchool(picking: Boolean) = _ui.update { it.copy(pickingSchool = picking) }

    fun chooseSchool(school: String?) {
        departments.select(school)
        _ui.update { it.copy(pickingSchool = false, department = departments.current()) }
    }

    fun reconnect(service: Service) {
        viewModelScope.launch {
            _ui.update { it.copy(busy = true, message = null) }
            try {
                auth.relogin(service, manual = true)
                _ui.update { it.copy(message = "${service.displayName}已重新连接") }
            } catch (e: Exception) {
                _ui.update { it.copy(message = "${service.displayName}重连失败:${e.message}") }
            }
            reload()
            _ui.update { it.copy(busy = false) }
        }
    }

    fun disconnect(service: Service) {
        auth.logout(service)
        reload()
    }

    fun saveLogin() {
        val state = _ui.value
        if (state.savingLogin) return
        viewModelScope.launch {
            _ui.update { it.copy(savingLogin = true, busy = true, message = null) }
            val otpSecret = when {
                state.clearSecret -> ""
                state.secretDraft.isBlank() -> null
                else -> state.secretDraft.trim()
            }
            val lines = mutableListOf<String>()
            var any = false
            for (service in Service.entries) {
                try {
                    auth.login(
                        service,
                        state.accountDraft,
                        state.passwordDraft,
                        otpCode = null,
                        otpSecret = otpSecret,
                        remember = true,
                    )
                    any = true
                    lines.add("${service.displayName}已登录")
                } catch (e: Exception) {
                    lines.add("${service.displayName}：${e.message ?: "登录失败"}")
                }
            }
            if (any) {
                _ui.update { it.copy(passwordDraft = "", secretDraft = "", clearSecret = false) }
            }
            reload()
            _ui.update {
                it.copy(
                    savingLogin = false,
                    busy = false,
                    message = if (any) lines.joinToString("；") else lines.joinToString("；").ifBlank { "登录没有成功，已保存的账号没有改动" },
                )
            }
        }
    }

    fun logoutAll() {
        auth.logoutAll()
        _ui.update {
            it.copy(
                accountDraft = "",
                passwordDraft = "",
                secretDraft = "",
                clearSecret = false,
                message = "已清除保存的账号、密码和手机令牌。各页面继续显示上次取到的数据。",
            )
        }
        reload()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavHostController, vm: SettingsViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()
    var confirmLogout by remember { mutableStateOf(false) }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("退出登录") },
            text = { Text("将清除本机保存的账号、密码和手机令牌。各页面继续显示上次取到的数据。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    vm.logoutAll()
                }) { Text("退出") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogout = false }) { Text("取消") }
            },
        )
    }

    if (ui.pickingSchool) {
        AlertDialog(
            onDismissRequest = { vm.setPickingSchool(false) },
            title = { Text("选择院系") },
            text = {
                LazyColumn(Modifier.fillMaxWidth().height(360.dp)) {
                    items(ui.schools) { school ->
                        Row(
                            modifier = Modifier.fillMaxWidth()
                                .clickable { vm.chooseSchool(school) }
                                .padding(vertical = 10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(school, style = MaterialTheme.typography.bodyMedium)
                            if (school == ui.department) {
                                Text("当前", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { vm.chooseSchool(null) }) { Text("清除手动选择") }
            },
            dismissButton = {
                TextButton(onClick = { vm.setPickingSchool(false) }) { Text("关闭") }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Text(
                    "服务连接",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
            Service.entries.forEach { service ->
                item(key = service.key) {
                    Card(Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(service.displayName, style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    if (ui.services[service] == true) "已连接" else "未连接",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (ui.services[service] == true) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            TextButton(onClick = { vm.reconnect(service) }, enabled = !ui.busy) {
                                Text("重连")
                            }
                            TextButton(onClick = { vm.disconnect(service) }, enabled = !ui.busy) {
                                Text("断开")
                            }
                        }
                    }
                }
            }

            item(key = "department") {
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.padding(16.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("本院通知", style = MaterialTheme.typography.bodyLarge)
                            Text(
                                ui.department?.takeIf { it.isNotBlank() }
                                    ?: "未能识别院系,可手动选择",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        TextButton(onClick = { vm.setPickingSchool(true) }) { Text("选择院系") }
                    }
                }
            }

            if (ui.message != null) {
                item {
                    Text(
                        ui.message!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(4.dp),
                    )
                }
            }

            item {
                Text(
                    "账号",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                )
            }
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(ui.username ?: "未登录", style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    if (ui.otpStored) "账号与手机令牌密钥加密保存在本机" else "账号加密保存在本机。尚未保存手机令牌密钥",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            IconButton(onClick = { confirmLogout = true }) {
                                Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "退出登录", tint = MaterialTheme.colorScheme.error)
                            }
                        }
                        Text(
                            "账号、密码和手机令牌密钥可以随时改。点「登录并保存」并且登录成功后，才会替换已保存的值。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = ui.accountDraft,
                            onValueChange = vm::setAccount,
                            label = { Text("校园账号") },
                            placeholder = { Text(ui.username ?: "学号或职工号") },
                            singleLine = true,
                            enabled = !ui.savingLogin,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = ui.passwordDraft,
                            onValueChange = vm::setPassword,
                            label = { Text("密码") },
                            placeholder = { Text("留空则继续用已保存的密码") },
                            singleLine = true,
                            enabled = !ui.savingLogin,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = ui.secretDraft,
                            onValueChange = vm::setSecret,
                            label = { Text("手机令牌密钥") },
                            placeholder = {
                                Text(if (ui.otpStored) "已保存。要更换就贴上新的 Base32 密钥" else "Base32 密钥，没有可以留空")
                            },
                            singleLine = true,
                            enabled = !ui.savingLogin,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = ui.clearSecret,
                                onCheckedChange = vm::setClearSecret,
                                enabled = !ui.savingLogin,
                            )
                            Text("登录成功后清除已保存的手机令牌", style = MaterialTheme.typography.bodySmall)
                        }
                        Button(onClick = vm::saveLogin, enabled = !ui.savingLogin && !ui.busy) {
                            Text(if (ui.savingLogin) "正在登录…" else "登录并保存")
                        }
                    }
                }
            }

            item {
                Text(
                    "关于",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                )
            }
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text("OnePKU Android", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "版本 ${BuildConfig.VERSION_NAME}\n数据仅保存在本机;学校数据归北京大学及各原站所有",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
