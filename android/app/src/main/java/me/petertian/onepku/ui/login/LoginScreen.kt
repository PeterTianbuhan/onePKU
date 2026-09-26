package me.petertian.onepku.ui.login

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.ui.navigation.Routes

@Composable
fun LoginScreen(nav: NavHostController, vm: LoginViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(72.dp))
        Text("OnePKU", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(6.dp))
        Text(
            "北大校园服务,本地运行\n教学网 · 树洞 · 校园卡",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(36.dp))

        OutlinedTextField(
            value = ui.username,
            onValueChange = vm::setUsername,
            label = { Text("学号") },
            singleLine = true,
            enabled = !ui.loggingIn,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = ui.password,
            onValueChange = vm::setPassword,
            label = { Text("统一身份认证密码") },
            singleLine = true,
            enabled = !ui.loggingIn,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = ui.otp,
            onValueChange = vm::setOtp,
            label = { Text("动态口令(未启用可留空)") },
            singleLine = true,
            enabled = !ui.loggingIn,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(24.dp))

        Button(
            onClick = { vm.login { nav.navigate(Routes.TODAY) { popUpTo(0) { inclusive = true } } } },
            enabled = !ui.loggingIn && ui.username.isNotBlank() && ui.password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (ui.loggingIn) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
                Text("正在登录…")
            } else {
                Text("登录")
            }
        }

        if (ui.results.isNotEmpty()) {
            Spacer(Modifier.height(24.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                ui.results.forEach { (service, ok, message) ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            if (ok) Icons.Filled.CheckCircle else Icons.Filled.Error,
                            contentDescription = null,
                            tint = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.size(8.dp))
                        Text(
                            "${service.displayName}:${if (ok) "已连接" else (message ?: "失败")}",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (ok) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(24.dp))
        Text(
            "密码加密存储于本机 Keystore,仅用于会话过期后自动重登,不会外传。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(32.dp))
    }
}

data class ServiceLoginResult(val service: Service, val ok: Boolean, val message: String?)

data class LoginUiState(
    val username: String = "",
    val password: String = "",
    val otp: String = "",
    val loggingIn: Boolean = false,
    val results: List<ServiceLoginResult> = emptyList(),
)
