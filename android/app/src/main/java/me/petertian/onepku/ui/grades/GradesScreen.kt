package me.petertian.onepku.ui.grades

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
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
import me.petertian.onepku.core.network.SmsVerificationRequiredException
import me.petertian.onepku.data.repo.GradeScopeStore
import me.petertian.onepku.data.repo.TreeholeRepository
import me.petertian.onepku.data.treehole.GradeScope
import me.petertian.onepku.data.treehole.ScoreEntry
import me.petertian.onepku.data.treehole.ScoreReport
import me.petertian.onepku.data.treehole.ScopeOverride
import me.petertian.onepku.data.treehole.countsAsMajor
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

data class GradesUiState(
    val refreshing: Boolean = false,
    val report: UiData<ScoreReport> = UiData.Loading,
    val scope: GradeScope = GradeScope.ALL,
    val override: ScopeOverride = ScopeOverride(),
    val editing: Boolean = false,
    val needSms: Boolean = false,
    val smsInfo: String? = null,
)

@HiltViewModel
class GradesViewModel @Inject constructor(
    private val repo: TreeholeRepository,
    private val scopeStore: GradeScopeStore,
) : ViewModel() {
    private val _ui = MutableStateFlow(GradesUiState())
    val ui: StateFlow<GradesUiState> = _ui.asStateFlow()

    init {
        load(false)
        viewModelScope.launch { scopeStore.state.collect { o -> _ui.update { it.copy(override = o) } } }
    }

    fun refresh() = load(true)

    fun setScope(scope: GradeScope) = _ui.update { it.copy(scope = scope) }

    fun setEditing(editing: Boolean) = _ui.update { it.copy(editing = editing) }

    fun toggleCourse(entry: ScoreEntry, include: Boolean) = scopeStore.setIncluded(entry, include)

    fun resetScope() = scopeStore.reset()

    fun load(force: Boolean) {
        viewModelScope.launch {
            _ui.update { it.copy(refreshing = true) }
            val result = try {
                _ui.update { s -> s.copy(needSms = false) }
                UiData.Ready(repo.scores(force))
            } catch (e: SmsVerificationRequiredException) {
                _ui.update { s -> s.copy(needSms = true) }
                UiData.Failure("树洞需要短信验证后才能查看成绩")
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "成绩加载失败")
            }
            _ui.update { it.copy(refreshing = false, report = result) }
        }
    }

    fun sendSms() {
        viewModelScope.launch {
            _ui.update { it.copy(smsInfo = try { repo.sendSms() } catch (e: Exception) { e.message }) }
        }
    }

    fun dismissSms() = _ui.update { it.copy(needSms = false) }

    fun verifySms(code: String) {
        viewModelScope.launch {
            try {
                repo.verifySms(code)
                _ui.update { it.copy(needSms = false, smsInfo = null) }
                load(true)
            } catch (e: Exception) {
                _ui.update { it.copy(smsInfo = e.message) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GradesScreen(nav: NavHostController, vm: GradesViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    if (ui.needSms) {
        SmsDialog(
            info = ui.smsInfo,
            onSend = vm::sendSms,
            onVerify = vm::verifySms,
            onDismiss = vm::dismissSms,
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("成绩") },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = ui.refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when (val data = ui.report) {
                is UiData.Loading -> LoadingBox()
                is UiData.Failure -> ErrorBox(data.message, onRetry = vm::refresh)
                is UiData.Ready -> GradesContent(data.value, ui, vm)
            }
        }
    }
}

@Composable
private fun GradesContent(report: ScoreReport, ui: GradesUiState, vm: GradesViewModel) {
    val scope = ui.scope
    val override = ui.override
    val stats = report.stats(scope, override)
    val byTerm = report.entries
        .filter { scope == GradeScope.ALL || it.countsAsMajor(override) }
        .sortedByDescending { it.termKey }
        .groupBy { it.termKey }

    if (ui.editing) {
        EditScopeDialog(
            entries = report.entries,
            override = override,
            onToggle = vm::toggleCourse,
            onReset = vm::resetScope,
            onDismiss = { vm.setEditing(false) },
        )
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(key = "scope") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GradeScope.entries.forEach { s ->
                    FilterChip(
                        selected = scope == s,
                        onClick = { vm.setScope(s) },
                        label = { Text(s.label) },
                    )
                }
            }
        }

        if (scope == GradeScope.MAJOR) {
            item(key = "scope-edit") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "自动按课程类别识别专业必修/限选;标成任选的专业课可手动加入。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { vm.setEditing(true) }) { Text("调整范围") }
                }
            }
        }

        item(key = "summary") {
            Card(Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.padding(20.dp).fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                ) {
                    val useSchool = scope == GradeScope.ALL && report.schoolGpa != null
                    SummaryItem(
                        label = if (useSchool) "GPA(学校)" else "GPA(本地计算)",
                        value = if (useSchool) report.schoolGpa!! else (stats.gpa?.let { fmt2(it) } ?: "—"),
                    )
                    SummaryItem(
                        label = "加权平均分",
                        value = stats.weightedAvg?.let { fmt2(it) } ?: "—",
                    )
                    SummaryItem(
                        label = if (scope == GradeScope.ALL) "总学分" else "口径内学分",
                        value = if (scope == GradeScope.ALL) (report.totalCredits ?: "—")
                        else fmt2(stats.credits),
                    )
                }
            }
            Text(
                when {
                    scope == GradeScope.ALL && report.schoolGpa != null ->
                        "GPA 来自学校;加权平均分与专业口径均为本地计算,仅供参考。"
                    scope == GradeScope.ALL ->
                        "学校未返回 GPA,已按官方规则在本地计算,仅供参考。"
                    else -> {
                        val manual = override.included.size + override.excluded.size
                        "口径:专业必修/限选${if (manual > 0) "(已手动调整 $manual 门)" else ""},共 ${stats.courseCount} 门计入;均为本地计算,仅供参考。"
                    }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp, start = 4.dp),
            )
        }

        byTerm.forEach { (term, entries) ->
            item(key = "term-$term") {
                val gpa = if (scope == GradeScope.ALL) {
                    report.termGpas.firstOrNull { it.term == term }?.gpa
                } else {
                    report.termStats(term, scope, override).gpa?.let { fmt2(it) }
                }
                Text(
                    formatTerm(term) + (gpa?.let { " · GPA $it" } ?: ""),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            items(entries, key = { "${it.termKey}-${it.name}-${it.score}" }) { e ->
                ScoreRow(e)
            }
        }
    }
}

private fun fmt2(v: Double): String = "%.2f".format(java.util.Locale.US, v)

@Composable
private fun SummaryItem(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ScoreRow(e: ScoreEntry) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(e.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                Text(
                    listOf(e.category, "${e.credit} 学分").filter { it.isNotBlank() && it != " 学分" }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                e.score,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = if ((e.score.toDoubleOrNull() ?: 100.0) < 60) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

private fun formatTerm(termKey: String): String {
    // termKey 形如 "25-26-1"
    val parts = termKey.split("-")
    if (parts.size == 3) {
        val termName = when (parts[2]) {
            "1" -> "秋"
            "2" -> "春"
            "3" -> "夏"
            else -> parts[2]
        }
        return "20${parts[0]}-20${parts[1]} 学年 ${termName}季学期"
    }
    return termKey
}

@Composable
private fun EditScopeDialog(
    entries: List<ScoreEntry>,
    override: ScopeOverride,
    onToggle: (ScoreEntry, Boolean) -> Unit,
    onReset: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sorted = entries.sortedWith(compareBy({ it.termKey }, { it.name }))
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("调整专业课范围") },
        text = {
            Column(Modifier.fillMaxWidth()) {
                Text(
                    "默认按课程类别识别专业必修/限选。被学校标成\"任选\"的专业课请手动勾上;不想计入的取消勾选。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.fillMaxWidth().height(360.dp)) {
                    items(sorted, key = { "${it.scopeKey}|${it.score}" }) { e ->
                        val checked = e.countsAsMajor(override)
                        Row(
                            modifier = Modifier.fillMaxWidth()
                                .clickable { onToggle(e, !checked) }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = checked, onCheckedChange = { onToggle(e, it) })
                            Column(Modifier.weight(1f)) {
                                Text(e.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                                Text(
                                    listOf(formatTerm(e.termKey), e.category.ifBlank { "未标注" }, "${e.credit} 学分")
                                        .joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text(e.score, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("完成") } },
        dismissButton = { TextButton(onClick = onReset) { Text("恢复自动识别") } },
    )
}

@Composable
internal fun SmsDialog(
    info: String?,
    onSend: () -> Unit,
    onVerify: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var code by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("树洞短信验证") },
        text = {
            Column {
                Text("树洞要求定期短信验证。点击发送验证码,输入短信中的 4-8 位数字。")
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.filter(Char::isDigit).take(8) },
                    label = { Text("验证码") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                if (info != null) {
                    Spacer(Modifier.height(8.dp))
                    Text(info, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onVerify(code) }, enabled = code.length in 4..8) { Text("验证") }
        },
        dismissButton = {
            TextButton(onClick = onSend) { Text("发送验证码") }
        },
    )
}
