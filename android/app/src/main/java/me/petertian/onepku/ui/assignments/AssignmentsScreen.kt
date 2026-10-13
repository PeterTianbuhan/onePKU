package me.petertian.onepku.ui.assignments

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
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
import me.petertian.onepku.data.course.AssignmentSummary
import me.petertian.onepku.data.repo.CourseRepository
import me.petertian.onepku.ui.components.EmptyBox
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.Routes
import me.petertian.onepku.ui.navigation.back
import me.petertian.onepku.ui.today.deadlineLabel
import javax.inject.Inject

enum class AssignmentFilter(val label: String) {
    PENDING("待交"), SUBMITTED("已提交"), CLOSED("已截止"), ALL("全部"),
}

data class AssignmentsUiState(
    val refreshing: Boolean = false,
    val filter: AssignmentFilter = AssignmentFilter.PENDING,
    val items: UiData<List<AssignmentSummary>> = UiData.Loading,
)

@HiltViewModel
class AssignmentsViewModel @Inject constructor(
    private val repo: CourseRepository,
) : ViewModel() {
    private val _ui = MutableStateFlow(AssignmentsUiState())
    val ui: StateFlow<AssignmentsUiState> = _ui.asStateFlow()

    init { load(false) }

    fun refresh() = load(true)

    fun setFilter(f: AssignmentFilter) = _ui.update { it.copy(filter = f) }

    private fun load(force: Boolean) {
        viewModelScope.launch {
            _ui.update { it.copy(refreshing = true) }
            val result = try {
                val list = repo.courses(force).filter { c -> c.isCurrent }
                UiData.Ready(repo.assignments(list, force))
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "作业加载失败")
            }
            _ui.update { it.copy(refreshing = false, items = result) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssignmentsScreen(nav: NavHostController, vm: AssignmentsViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("作业") },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AssignmentFilter.entries.forEach { f ->
                    FilterChip(
                        selected = ui.filter == f,
                        onClick = { vm.setFilter(f) },
                        label = { Text(f.label) },
                    )
                }
            }
            PullToRefreshBox(
                isRefreshing = ui.refreshing,
                onRefresh = vm::refresh,
                modifier = Modifier.fillMaxSize(),
            ) {
                when (val data = ui.items) {
                    is UiData.Loading -> LoadingBox()
                    is UiData.Failure -> ErrorBox(data.message, onRetry = vm::refresh)
                    is UiData.Ready -> {
                        val now = System.currentTimeMillis()
                        val filtered = data.value.filter { a ->
                            when (ui.filter) {
                                AssignmentFilter.PENDING -> !a.submitted &&
                                    (a.deadlineEpochMs ?: Long.MAX_VALUE) >= now
                                AssignmentFilter.SUBMITTED -> a.submitted
                                // 没有截止时间就不算已截止,与"待交"一样按不设限处理
                                AssignmentFilter.CLOSED -> !a.submitted &&
                                    (a.deadlineEpochMs ?: Long.MAX_VALUE) < now
                                AssignmentFilter.ALL -> true
                            }
                        }
                        if (filtered.isEmpty()) {
                            EmptyBox("暂无符合条件的作业")
                        } else {
                            // 待交按最快到期在上;其余筛选按最近提交在上,没有提交时间的退回截止时间倒序。
                            val ordered = filtered.sortedWith(
                                if (ui.filter == AssignmentFilter.PENDING) {
                                    compareBy { a: AssignmentSummary -> a.deadlineEpochMs ?: Long.MAX_VALUE }
                                } else {
                                    compareByDescending<AssignmentSummary> { a -> a.submittedAtEpochMs ?: -1L }
                                        .thenByDescending { a -> a.deadlineEpochMs ?: -1L }
                                },
                            )
                            LazyColumn(
                                modifier = Modifier.fillMaxSize(),
                                contentPadding = PaddingValues(16.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                items(ordered, key = { "${it.courseId}-${it.contentId}" }) { a ->
                                    Card(
                                        Modifier.fillMaxWidth().clickable {
                                            nav.navigate(Routes.assignmentDetail(a.courseId, a.contentId, a.title))
                                        },
                                    ) {
                                        Row(
                                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Column(Modifier.weight(1f)) {
                                                Text(a.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
                                                Text(
                                                    a.courseName,
                                                    style = MaterialTheme.typography.bodySmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }
                                            Column(horizontalAlignment = Alignment.End) {
                                                Text(
                                                    if (a.submitted) "已提交" else "未提交",
                                                    style = MaterialTheme.typography.labelMedium,
                                                    color = if (a.submitted) MaterialTheme.colorScheme.primary
                                                    else MaterialTheme.colorScheme.error,
                                                )
                                                a.scoreText?.let {
                                                    Text(
                                                        it,
                                                        style = MaterialTheme.typography.titleSmall,
                                                        fontWeight = FontWeight.SemiBold,
                                                        color = MaterialTheme.colorScheme.primary,
                                                    )
                                                }
                                                // 已提交就不显示截止时间,交了之后那个时间没有意义。
                                                if (!a.submitted) {
                                                    Text(
                                                        deadlineLabel(a.deadlineEpochMs),
                                                        style = MaterialTheme.typography.bodySmall,
                                                        color = if ((a.deadlineEpochMs ?: Long.MAX_VALUE) - now < 24 * 3600_000 &&
                                                            (a.deadlineEpochMs ?: 0L) >= now
                                                        ) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
