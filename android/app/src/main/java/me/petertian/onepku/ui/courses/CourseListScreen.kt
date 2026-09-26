package me.petertian.onepku.ui.courses

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
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
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
import me.petertian.onepku.data.course.CourseInfo
import me.petertian.onepku.data.repo.CourseRepository
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.Routes
import javax.inject.Inject

data class CoursesUiState(
    val refreshing: Boolean = false,
    val courses: UiData<List<CourseInfo>> = UiData.Loading,
)

@HiltViewModel
class CoursesViewModel @Inject constructor(
    private val repo: CourseRepository,
) : ViewModel() {
    private val _ui = MutableStateFlow(CoursesUiState())
    val ui: StateFlow<CoursesUiState> = _ui.asStateFlow()

    init { load(false) }

    fun refresh() = load(true)

    private fun load(force: Boolean) {
        viewModelScope.launch {
            _ui.update { it.copy(refreshing = true) }
            val result = try {
                UiData.Ready(repo.courses(force))
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "课程加载失败")
            }
            _ui.update { it.copy(refreshing = false, courses = result) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CourseListScreen(nav: NavHostController, vm: CoursesViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    Scaffold(topBar = { TopAppBar(title = { Text("课程") }) }) { padding ->
        PullToRefreshBox(
            isRefreshing = ui.refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when (val data = ui.courses) {
                is UiData.Loading -> LoadingBox()
                is UiData.Failure -> ErrorBox(data.message, onRetry = vm::refresh)
                is UiData.Ready -> {
                    val groups = data.value
                        .groupBy { it.semester }
                        .toList()
                        .sortedWith(Comparator { a, b ->
                            val aOther = a.first == "其他"
                            val bOther = b.first == "其他"
                            when {
                                aOther != bOther -> if (aOther) 1 else -1
                                else -> b.first.compareTo(a.first)
                            }
                        })
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        groups.forEach { (semester, list) ->
                            item(key = "sem-$semester") {
                                Text(
                                    semester,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                                )
                            }
                            items(list, key = { it.id }) { course ->
                                Card(
                                    Modifier.fillMaxWidth().clickable {
                                        nav.navigate(Routes.courseDetail(course.id, course.name))
                                    },
                                ) {
                                    Row(
                                        modifier = Modifier.padding(16.dp).fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(course.name, style = MaterialTheme.typography.bodyLarge)
                                            Text(
                                                course.longTitle.substringBefore(":"),
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                        if (course.isCurrent) {
                                            Text(
                                                "本学期",
                                                style = MaterialTheme.typography.labelSmall,
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
        }
    }
}
