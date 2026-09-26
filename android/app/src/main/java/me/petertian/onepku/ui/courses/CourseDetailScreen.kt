package me.petertian.onepku.ui.courses

import android.content.Intent
import android.widget.Toast
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import me.petertian.onepku.BuildConfig
import me.petertian.onepku.data.course.Announcement
import me.petertian.onepku.data.course.AssignmentSummary
import me.petertian.onepku.data.course.Attachment
import me.petertian.onepku.data.course.ContentItem
import me.petertian.onepku.data.course.ContentType
import me.petertian.onepku.data.course.LearningGrade
import me.petertian.onepku.data.repo.CourseRepository
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.HtmlText
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.Routes
import me.petertian.onepku.ui.navigation.back
import me.petertian.onepku.ui.today.deadlineLabel
import java.io.File
import javax.inject.Inject

data class CourseDetailUiState(
    val courseId: String = "",
    val courseName: String = "",
    val tab: Int = 0,
    val announcements: UiData<List<Announcement>> = UiData.Loading,
    val assignments: UiData<List<AssignmentSummary>> = UiData.Loading,
    val materials: UiData<List<ContentItem>> = UiData.Loading,
    val grades: UiData<List<LearningGrade>> = UiData.Loading,
    val downloading: Set<String> = emptySet(),
)

@HiltViewModel
class CourseDetailViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val repo: CourseRepository,
) : ViewModel() {
    private val courseId: String = checkNotNull(savedState["courseId"])
    private val courseName: String = savedState.get<String>("name").orEmpty()

    private val _ui = MutableStateFlow(CourseDetailUiState(courseId = courseId, courseName = courseName))
    val ui: StateFlow<CourseDetailUiState> = _ui.asStateFlow()

    init { loadAnnouncements() }

    fun setTab(tab: Int) {
        _ui.update { it.copy(tab = tab) }
        when (tab) {
            0 -> if (_ui.value.announcements is UiData.Loading) loadAnnouncements()
            1 -> if (_ui.value.assignments is UiData.Loading) loadAssignments()
            2 -> if (_ui.value.materials is UiData.Loading) loadMaterials()
            3 -> if (_ui.value.grades is UiData.Loading) loadGrades()
        }
    }

    fun loadAssignments() = viewModelScope.launch {
        _ui.update { it.copy(assignments = UiData.Loading) }
        _ui.update {
            it.copy(
                assignments = try {
                    UiData.Ready(repo.assignmentsForCourse(courseId, courseName))
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "作业加载失败")
                },
            )
        }
    }

    fun loadAnnouncements() = viewModelScope.launch {
        _ui.update { it.copy(announcements = UiData.Loading) }
        _ui.update {
            it.copy(
                announcements = try {
                    UiData.Ready(repo.announcements(courseId, courseName))
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "通知加载失败")
                },
            )
        }
    }

    fun loadMaterials() = viewModelScope.launch {
        _ui.update { it.copy(materials = UiData.Loading) }
        _ui.update {
            it.copy(
                materials = try {
                    UiData.Ready(repo.content(courseId).filter { item -> item.type == ContentType.DOCUMENT })
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "资料加载失败")
                },
            )
        }
    }

    fun loadGrades() = viewModelScope.launch {
        _ui.update { it.copy(grades = UiData.Loading) }
        _ui.update {
            it.copy(
                grades = try {
                    UiData.Ready(repo.learningGrades(courseId))
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "成绩加载失败")
                },
            )
        }
    }

    fun download(attachment: Attachment, onDone: (File) -> Unit) = viewModelScope.launch {
        if (attachment.url in _ui.value.downloading) return@launch
        _ui.update { it.copy(downloading = it.downloading + attachment.url) }
        try {
            val file = repo.download(courseName, attachment)
            withContext(Dispatchers.Main) { onDone(file) }
        } catch (_: Exception) {
            // 由 UI 层 toast
        }
        _ui.update { it.copy(downloading = it.downloading - attachment.url) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CourseDetailScreen(nav: NavHostController, vm: CourseDetailViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()
    val tabs = listOf("通知", "作业", "资料", "成绩")

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(ui.courseName, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = ui.tab) {
                tabs.forEachIndexed { index, title ->
                    Tab(
                        selected = ui.tab == index,
                        onClick = { vm.setTab(index) },
                        text = { Text(title) },
                    )
                }
            }
            when (ui.tab) {
                0 -> AnnouncementsTab(ui.announcements, vm::loadAnnouncements)
                1 -> AssignmentsTab(ui, vm, nav)
                2 -> MaterialsTab(ui, vm)
                3 -> GradesTab(ui.grades, vm::loadGrades)
            }
        }
    }
}

@Composable
private fun AnnouncementsTab(data: UiData<List<Announcement>>, onRetry: () -> Unit) {
    when (data) {
        is UiData.Loading -> LoadingBox()
        is UiData.Failure -> ErrorBox(data.message, onRetry = onRetry)
        is UiData.Ready -> {
            if (data.value.isEmpty()) {
                ErrorBox("本课程暂无通知")
                return
            }
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(data.value, key = { it.id }) { n ->
                    var expanded by rememberSaveable(n.id) { mutableStateOf(false) }
                    Card(Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
                        Column(Modifier.padding(16.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(n.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                                Icon(
                                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                                    contentDescription = null,
                                )
                            }
                            Text(
                                listOf(n.date, n.author).filter { it.isNotBlank() }.joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (expanded && n.bodyHtml.isNotBlank()) {
                                Spacer(Modifier.height(8.dp))
                                HtmlText(n.bodyHtml)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MaterialsTab(ui: CourseDetailUiState, vm: CourseDetailViewModel) {
    val context = LocalContext.current
    when (val data = ui.materials) {
        is UiData.Loading -> LoadingBox()
        is UiData.Failure -> ErrorBox(data.message) { vm.loadMaterials() }
        is UiData.Ready -> {
            val files = data.value.flatMap { item ->
                item.attachments.map { it to item }
            }
            if (files.isEmpty()) {
                ErrorBox("本课程暂无可下载资料")
                return
            }
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(files, key = { it.first.url }) { (attachment, item) ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(attachment.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                                if (item.title != attachment.name) {
                                    Text(
                                        item.title,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                    )
                                }
                            }
                            if (attachment.url in ui.downloading) {
                                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                            } else {
                                IconButton(onClick = {
                                    vm.download(attachment) { file ->
                                        openFile(context, file)
                                    }
                                }) {
                                    Icon(Icons.Filled.Download, contentDescription = "下载")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AssignmentsTab(ui: CourseDetailUiState, vm: CourseDetailViewModel, nav: NavHostController) {
    when (val data = ui.assignments) {
        is UiData.Loading -> LoadingBox()
        is UiData.Failure -> ErrorBox(data.message, onRetry = vm::loadAssignments)
        is UiData.Ready -> {
            if (data.value.isEmpty()) {
                ErrorBox("本课程暂无作业")
                return
            }
            val now = System.currentTimeMillis()
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(data.value, key = { it.contentId }) { a ->
                    Card(
                        modifier = Modifier.fillMaxWidth().clickable {
                            nav.navigate(Routes.assignmentDetail(ui.courseId, a.contentId, a.title))
                        },
                    ) {
                        Row(
                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(a.title, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                                Text(
                                    a.deadlineRaw ?: "无截止时间",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            val overdue = a.deadlineEpochMs?.let { it < now } == true
                            Column(horizontalAlignment = Alignment.End) {
                                Text(
                                    when {
                                        a.submitted -> "已提交"
                                        overdue -> "已截止"
                                        else -> deadlineLabel(a.deadlineEpochMs).ifBlank { "进行中" }
                                    },
                                    style = MaterialTheme.typography.labelMedium,
                                    color = when {
                                        a.submitted -> MaterialTheme.colorScheme.primary
                                        overdue -> MaterialTheme.colorScheme.error
                                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                )
                                a.scoreText?.let {
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.titleSmall,
                                        fontWeight = FontWeight.SemiBold,
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

private fun openFile(context: android.content.Context, file: File) {
    runCatching {
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, context.contentResolver.getType(uri) ?: "*/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.onFailure {
        Toast.makeText(context, "已下载:${file.absolutePath}", Toast.LENGTH_LONG).show()
    }
}

@Composable
private fun GradesTab(data: UiData<List<LearningGrade>>, onRetry: () -> Unit) {
    when (data) {
        is UiData.Loading -> LoadingBox()
        is UiData.Failure -> ErrorBox(data.message, onRetry = onRetry)
        is UiData.Ready -> {
            if (data.value.isEmpty()) {
                ErrorBox("本课程暂无教学网成绩")
                return
            }
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(data.value, key = { it.id }) { g ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.padding(16.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(g.title, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    listOf(g.category, g.status, g.updated).filter { it.isNotBlank() }.joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Text(
                                g.score,
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = if (g.score == "-") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }
        }
    }
}
