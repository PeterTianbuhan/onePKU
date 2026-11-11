package me.petertian.onepku.ui.settings

import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import me.petertian.onepku.BuildConfig
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.auth.Totp
import me.petertian.onepku.data.news.SchoolNoticeApi
import me.petertian.onepku.data.replay.ProgressSync
import me.petertian.onepku.data.repo.DepartmentStore
import me.petertian.onepku.ui.navigation.back
import me.petertian.onepku.ui.navigation.toLogin
import javax.inject.Inject

data class SettingsUiState(
    val username: String? = null,
    val services: Map<Service, Boolean> = emptyMap(),
    val department: String? = null,
    val schools: List<String> = emptyList(),
    val pickingSchool: Boolean = false,
    val busy: Boolean = false,
    val message: String? = null,
    val progress: ProgressSync.Editor = ProgressSync.Editor("", false, false, false),
    val autoUsername: String = "",
    val passwordSaved: Boolean = false,
    val secretSaved: Boolean = false,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val auth: AuthManager,
    private val departments: DepartmentStore,
    private val progress: ProgressSync,
    schoolNotices: SchoolNoticeApi,
) : ViewModel() {

    private val _ui = MutableStateFlow(SettingsUiState(schools = schoolNotices.schools()))
    val ui: StateFlow<SettingsUiState> = _ui.asStateFlow()

    init { reload() }

    fun reload() {
        _ui.update {
            it.copy(
                username = auth.storedUsername(),
                services = Service.entries.associateWith { s -> auth.isLoggedIn(s) },
                department = departments.current(),
                progress = progress.editor(),
                autoUsername = auth.storedUsername().orEmpty(),
                passwordSaved = auth.hasCredentials(),
                secretSaved = auth.otpSaved(),
            )
        }
    }

    fun previewCode(draft: String, nowMs: Long): String? = auth.previewCode(draft, nowMs)

    fun saveAutoLogin(username: String, password: String, secret: String): Boolean {
        val error = auth.saveAutoLogin(username, password, secret)
        if (error != null) {
            _ui.update { it.copy(message = error) }
            return false
        }
        reload()
        _ui.update { it.copy(message = "已保存。会话过期时会用当前口令自动登录") }
        return true
    }

    fun clearAutoLogin() {
        auth.clearAutoLogin()
        reload()
        _ui.update { it.copy(message = "已清除密码和动态口令") }
    }

    fun saveProgress(url: String, token: String?) {
        progress.saveOverride(url, token)
        reload()
    }

    fun clearProgress() {
        progress.clearOverride()
        reload()
    }

    fun setPickingSchool(picking: Boolean) = _ui.update { it.copy(pickingSchool = picking) }

    fun chooseSchool(school: String?) {
        departments.select(school)
        _ui.update { it.copy(pickingSchool = false, department = departments.current()) }
    }

    fun reconnect(service: Service) {
        viewModelScope.launch {
            _ui.update { it.copy(busy = true, message = null) }
            try {
                auth.relogin(service)
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

    fun logoutAll(onDone: () -> Unit) {
        auth.logoutAll()
        onDone()
    }
}

@Composable
private fun ProgressSyncCard(
    editor: ProgressSync.Editor,
    onSave: (String, String?) -> Unit,
    onClear: () -> Unit,
) {
    var url by remember(editor.url) { mutableStateOf(editor.url) }
    var token by remember { mutableStateOf("") }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("观看进度", style = MaterialTheme.typography.bodyLarge)
            Text(
                when {
                    editor.enabled -> "已开启。打开回放时与电脑上的进度对齐。"
                    editor.tokenSet -> "令牌已有，地址还不能用，同步关闭。"
                    else -> "未设置令牌，同步关闭。公开安装包默认就是这样。"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("同步地址") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("令牌") },
                placeholder = { Text(if (editor.tokenSet) "已保存，留空则不修改" else "至少 24 位") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row {
                TextButton(onClick = { onSave(url, token.ifBlank { null }); token = "" }) { Text("保存") }
                if (editor.overrideSet) {
                    TextButton(onClick = onClear) { Text("清除覆盖") }
                }
            }
        }
    }
}

@Composable
private fun AutoLoginCard(
    username: String,
    passwordSaved: Boolean,
    secretSaved: Boolean,
    enabled: Boolean,
    preview: (String, Long) -> String?,
    onSave: (String, String, String) -> Boolean,
    onClear: () -> Unit,
) {
    var id by remember(username) { mutableStateOf(username) }
    var password by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    var confirmClear by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }
    val secretInvalid = secret.isNotBlank() && Totp.parseSecret(secret) == null
    val code = if (secretInvalid) null else preview(secret, now)
    val remain = (Totp.PERIOD_SEC - (now / 1000 % Totp.PERIOD_SEC)).toInt()

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清除自动登录") },
            text = { Text("清除已保存的密码和动态口令。学号还留着。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    password = ""
                    secret = ""
                    onClear()
                }) { Text("清除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmClear = false }) { Text("取消") }
            },
        )
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "填写统一身份认证密码。有手机令牌就粘贴 otpauth:// 链接或 Base32 密钥，没有就留空。只存在本机，不进备份，也不发到进度同步。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = id,
                onValueChange = { id = it.trim() },
                label = { Text("学号") },
                singleLine = true,
                enabled = enabled,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("统一身份认证密码") },
                placeholder = { Text(if (passwordSaved) "已保存，留空则不修改" else "") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                singleLine = true,
                enabled = enabled,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = secret,
                onValueChange = { secret = it.trim() },
                label = { Text("手机令牌") },
                placeholder = { Text(if (secretSaved) "已保存，留空则不修改" else "otpauth:// 或 Base32，可留空") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                singleLine = true,
                enabled = enabled,
                isError = secretInvalid,
                modifier = Modifier.fillMaxWidth(),
            )
            if (secretInvalid) {
                Text(
                    "无法识别，请粘贴 otpauth:// 链接或 Base32 密钥",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            } else if (code != null) {
                Text(
                    "当前口令 $code · ${remain} 秒后更换",
                    style = MaterialTheme.typography.bodyLarge,
                )
            } else if (secret.isBlank() && secretSaved) {
                Text(
                    "已保存的密钥生成不了口令",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Row {
                TextButton(
                    onClick = {
                        if (onSave(id, password, secret)) {
                            password = ""
                            secret = ""
                        }
                    },
                    enabled = enabled && !secretInvalid && id.isNotBlank() && (password.isNotEmpty() || passwordSaved),
                ) { Text("保存") }
                if (passwordSaved || secretSaved) {
                    TextButton(onClick = { confirmClear = true }, enabled = enabled) { Text("清除") }
                }
            }
        }
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
            text = { Text("将清除本机保存的凭证与全部服务会话") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    vm.logoutAll { nav.toLogin() }
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
                    "自动登录",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
            item(key = "auto-login") {
                AutoLoginCard(
                    username = ui.autoUsername,
                    passwordSaved = ui.passwordSaved,
                    secretSaved = ui.secretSaved,
                    enabled = !ui.busy,
                    preview = vm::previewCode,
                    onSave = vm::saveAutoLogin,
                    onClear = vm::clearAutoLogin,
                )
            }
            item {
                Text(
                    "服务连接",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
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

            item(key = "progress") { ProgressSyncCard(ui.progress, vm::saveProgress, vm::clearProgress) }

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
                    Row(
                        modifier = Modifier.padding(16.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(ui.username ?: "未登录", style = MaterialTheme.typography.bodyLarge)
                            Text(
                                when {
                                    ui.passwordSaved && ui.secretSaved -> "密码和手机令牌加密存储于本机"
                                    ui.passwordSaved -> "密码加密存储于本机"
                                    else -> "尚未保存密码"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { confirmLogout = true }) {
                            Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "退出登录", tint = MaterialTheme.colorScheme.error)
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
