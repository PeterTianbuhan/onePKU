package me.petertian.onepku.ui.mine

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Grade
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material.icons.outlined.MenuBook
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.ui.navigation.Routes
import javax.inject.Inject

data class MineUiState(
    val username: String? = null,
    val services: Map<Service, Boolean> = emptyMap(),
)

@HiltViewModel
class MineViewModel @Inject constructor(
    private val auth: AuthManager,
) : ViewModel() {
    private val _ui = MutableStateFlow(
        MineUiState(
            username = auth.storedUsername(),
            services = Service.entries.associateWith { auth.isLoggedIn(it) },
        ),
    )
    val ui: StateFlow<MineUiState> = _ui.asStateFlow()
}

private data class Entry(val route: String, val label: String, val desc: String, val icon: ImageVector)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MineScreen(nav: NavHostController, vm: MineViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    val entries = listOf(
        Entry(Routes.ASSIGNMENTS, "作业", "跨课程作业与提交记录", Icons.AutoMirrored.Outlined.Assignment),
        Entry(Routes.GRADES, "成绩", "正式成绩与 GPA", Icons.Outlined.Grade),
        Entry(Routes.CURRICULUM, "培养方案", "毕业要求与各大类完成度", Icons.Outlined.MenuBook),
        Entry(Routes.CARD, "校园卡", "余额、收支与流水", Icons.Outlined.CreditCard),
        Entry(Routes.CLASSROOM, "空闲教室", "按教学楼与节次查询", Icons.Outlined.MeetingRoom),
        Entry(Routes.CALENDAR, "校历", "学校官方校历 PDF", Icons.Outlined.CalendarMonth),
        Entry(Routes.SETTINGS, "设置", "服务连接与账号", Icons.Outlined.Settings),
    )

    Scaffold(topBar = { TopAppBar(title = { Text("我的") }) }) { padding ->
        LazyColumn(
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            ui.username ?: "未登录",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            Service.entries.joinToString(" · ") { s ->
                                "${s.displayName}${if (ui.services[s] == true) "✓" else "—"}"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            entries.forEach { entry ->
                item(key = entry.route) {
                    Card(Modifier.fillMaxWidth().clickable { nav.navigate(entry.route) }) {
                        Row(
                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(entry.icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                            Column(Modifier.weight(1f).padding(start = 16.dp)) {
                                Text(entry.label, style = MaterialTheme.typography.bodyLarge)
                                Text(entry.desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Icon(
                                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
