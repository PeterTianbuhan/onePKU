package me.petertian.onepku.ui.today

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import me.petertian.onepku.data.card.fenToYuan
import me.petertian.onepku.ui.components.SectionContent
import me.petertian.onepku.ui.navigation.Routes
import me.petertian.onepku.ui.navigation.toLogin
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayScreen(nav: NavHostController, vm: TodayViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    LaunchedEffect(ui.loggedOut) {
        if (ui.loggedOut) nav.toLogin()
    }

    Scaffold(topBar = { TopAppBar(title = { Text("今日") }) }) { padding ->
        PullToRefreshBox(
            isRefreshing = ui.refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "assignments") {
                    TodaySection(title = "待交作业", action = "全部" to { nav.navigate(Routes.ASSIGNMENTS) }) {
                        SectionContent(
                            data = ui.assignments,
                            onRetry = vm::refresh,
                            isEmpty = { it.isEmpty() },
                            emptyMessage = "没有临近截止的作业",
                        ) { list ->
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                list.take(5).forEach { a ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                nav.navigate(Routes.assignmentDetail(a.courseId, a.contentId, a.title))
                                            },
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(a.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                                            Text(a.courseName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                        }
                                        Spacer(Modifier.padding(4.dp))
                                        Text(
                                            deadlineLabel(a.deadlineEpochMs),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = if ((a.deadlineEpochMs ?: Long.MAX_VALUE) - System.currentTimeMillis() < 24 * 3600 * 1000)
                                                MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                item(key = "announcements") {
                    TodaySection(title = "课程通知", action = null) {
                        SectionContent(
                            data = ui.announcements,
                            onRetry = vm::refresh,
                            isEmpty = { it.isEmpty() },
                            emptyMessage = "暂无课程通知",
                        ) { list ->
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                list.take(6).forEach { n ->
                                    Column(
                                        Modifier.clickable {
                                            nav.navigate(Routes.courseDetail(n.courseId, n.courseName))
                                        },
                                    ) {
                                        Text(n.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                                        Text(
                                            "${n.courseName} · ${n.date}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                item(key = "card") {
                    TodaySection(title = "校园卡", action = "详情" to { nav.navigate(Routes.CARD) }) {
                        SectionContent(data = ui.cardBalance, onRetry = vm::refresh) { balance ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("余额", style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    "¥${fenToYuan(balance.totalFen)}",
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TodaySection(title: String, action: Pair<String, () -> Unit>?, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                if (action != null) {
                    Text(
                        action.first,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable(onClick = action.second),
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

fun deadlineLabel(epochMs: Long?): String {
    if (epochMs == null) return "无截止时间"
    val now = System.currentTimeMillis()
    val diff = epochMs - now
    if (diff < 0) return "已截止"
    val hours = diff / 3600_000
    if (hours < 1) return "不足 1 小时"
    if (hours < 24) return "剩 ${hours} 小时"
    val days = hours / 24
    if (days < 7) return "剩 ${days} 天"
    return SimpleDateFormat("M月d日 HH:mm", Locale.CHINA).format(Date(epochMs))
}
