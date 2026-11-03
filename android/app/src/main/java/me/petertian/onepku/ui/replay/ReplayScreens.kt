package me.petertian.onepku.ui.replay

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import me.petertian.onepku.data.replay.Haoxue
import me.petertian.onepku.data.replay.ReplayCourse
import me.petertian.onepku.data.replay.ReplayRepository
import me.petertian.onepku.data.replay.ReplayStore
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.Routes
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

private const val FIRST_SWEEP = "第一次打开要把最近半年的课堂记录扫一遍，大约半分钟…"

// ---- 全部回放：按课程分组 ----

@HiltViewModel
class ReplayHomeViewModel @Inject constructor(
    private val repo: ReplayRepository,
    val store: ReplayStore,
) : ViewModel() {
    private val _courses = MutableStateFlow<UiData<List<ReplayCourse>>>(UiData.Loading)
    val courses: StateFlow<UiData<List<ReplayCourse>>> = _courses.asStateFlow()
    val loadingMessage = if (repo.firstSweep()) FIRST_SWEEP else "加载中…"

    init { load(false) }

    fun load(force: Boolean) = viewModelScope.launch {
        _courses.value = UiData.Loading
        _courses.value = try {
            UiData.Ready(repo.courses(force))
        } catch (e: Exception) {
            UiData.Failure(replayError(e, "课堂实录加载失败"))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReplayHomeScreen(nav: NavHostController, vm: ReplayHomeViewModel = hiltViewModel()) {
    val courses by vm.courses.collectAsState()
    val states by vm.store.states.collectAsState()
    val saved = states.values.filter { it.keep && it.lesson != null }.sortedByDescending { it.lesson!!.time }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("课程回放") },
                navigationIcon = { IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                actions = { IconButton(onClick = { vm.load(true) }) { Icon(Icons.Filled.Refresh, "刷新") } },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (saved.isNotEmpty()) {
                    item { SectionTitle("已下载 · ${formatBytes(saved.sumOf { it.bytes })}") }
                    items(saved, key = { "saved-" + it.lesson!!.key }) { local ->
                        LessonRow(local.lesson!!, local, showCourse = true, onOpen = { nav.navigate(Routes.replayPlayer(local.lesson)) }, store = vm.store)
                    }
                    item { SectionTitle("全部课程") }
                }
                when (val data = courses) {
                    is UiData.Loading -> item { LoadingBox(Modifier.padding(vertical = 48.dp), vm.loadingMessage) }
                    is UiData.Failure -> item { ErrorBox(data.message, Modifier.padding(vertical = 24.dp)) { vm.load(true) } }
                    is UiData.Ready -> {
                        if (data.value.isEmpty()) {
                            item { ErrorBox("最近半年的课堂记录里没有可播放的回放", Modifier.padding(vertical = 24.dp)) }
                        }
                        items(data.value, key = { "course-" + it.name }) { course ->
                            Card(Modifier.fillMaxWidth().clickable { nav.navigate(Routes.replayCourse(course.name)) }) {
                                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(course.name, style = MaterialTheme.typography.bodyLarge)
                                        Text(
                                            "${course.lessons.size} 节 · 最近 ${course.latest.take(10)}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---- 一门课的回放：课程页的「回放」标签和课程回放页共用 ----

@HiltViewModel
class ReplayLessonsViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val repo: ReplayRepository,
    val store: ReplayStore,
) : ViewModel() {
    val name: String = savedState.get<String>("name").orEmpty()
    private val _lessons = MutableStateFlow<UiData<List<Haoxue.Lesson>>>(UiData.Loading)
    val lessons: StateFlow<UiData<List<Haoxue.Lesson>>> = _lessons.asStateFlow()
    val loadingMessage = if (repo.firstSweep()) FIRST_SWEEP else "加载中…"

    init { load(false) }

    fun load(force: Boolean) = viewModelScope.launch {
        _lessons.value = UiData.Loading
        _lessons.value = try {
            UiData.Ready(repo.lessons(name, force))
        } catch (e: Exception) {
            UiData.Failure(replayError(e, "回放加载失败"))
        }
    }
}

@Composable
fun ReplayLessonsTab(nav: NavHostController, vm: ReplayLessonsViewModel = hiltViewModel()) {
    val lessons by vm.lessons.collectAsState()
    val states by vm.store.states.collectAsState()
    when (val data = lessons) {
        is UiData.Loading -> LoadingBox(message = vm.loadingMessage)
        is UiData.Failure -> ErrorBox(data.message) { vm.load(true) }
        is UiData.Ready -> {
            if (data.value.isEmpty()) {
                ErrorBox("这门课在课堂实录里还没有可播放的回放") { vm.load(true) }
                return
            }
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(data.value, key = { it.key }) { lesson ->
                    LessonRow(lesson, states[lesson.key], showCourse = false, onOpen = { nav.navigate(Routes.replayPlayer(lesson)) }, store = vm.store)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReplayCourseScreen(nav: NavHostController, vm: ReplayLessonsViewModel = hiltViewModel()) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(vm.name, maxLines = 1) },
                navigationIcon = { IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                actions = { IconButton(onClick = { vm.load(true) }) { Icon(Icons.Filled.Refresh, "刷新") } },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) { ReplayLessonsTab(nav, vm) }
    }
}

// ---- 公共部件 ----

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
}

/** 本机状态的一句话：已下载 / 下载中 / 没下完 / 看过的部分存了多少。 */
fun localLabel(local: ReplayStore.Local?): String? {
    if (local == null || local.total == 0 && !local.downloading) return null
    val percent = if (local.total > 0) local.done * 100 / local.total else 0
    return when {
        local.complete -> "已下载 · ${formatBytes(local.bytes)}"
        local.downloading -> "下载中 $percent%"
        local.keep && local.error != null -> "没下完 $percent%：${local.error}"
        local.keep -> "没下完 $percent%"
        local.done > 0 -> "看过的部分已存 $percent%"
        else -> null
    }
}

@Composable
fun rememberNotificationAsk(): (() -> Unit) -> Unit {
    val context = LocalContext.current
    // 不管允不允许通知都照样下载，通知只是让你在后台看得到进度。
    val pending = remember { arrayOfNulls<() -> Unit>(1) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        pending[0]?.invoke()
        pending[0] = null
    }
    return { action ->
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pending[0] = action
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            action()
        }
    }
}

@Composable
private fun LessonRow(
    lesson: Haoxue.Lesson,
    local: ReplayStore.Local?,
    showCourse: Boolean,
    onOpen: () -> Unit,
    store: ReplayStore,
) {
    val ask = rememberNotificationAsk()
    Card(Modifier.fillMaxWidth().clickable(onClick = onOpen)) {
        Row(Modifier.padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (showCourse) lesson.courseName else lesson.title, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                Text(
                    listOf(if (showCourse) lesson.title else "", lesson.time, lesson.room).filter { it.isNotBlank() }.distinct().joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                localLabel(local)?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (local?.error != null && local.keep && !local.complete) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        maxLines = 2,
                    )
                }
            }
            when {
                local?.downloading == true -> CircularProgressIndicator(
                    progress = { if (local.total > 0) local.done.toFloat() / local.total else 0f },
                    modifier = Modifier.padding(12.dp).size(24.dp),
                    strokeWidth = 2.dp,
                )
                local?.keep == true && local.complete -> IconButton(onClick = { store.delete(lesson.key) }) { Icon(Icons.Filled.Delete, "删除下载") }
                else -> IconButton(onClick = { ask { store.download(lesson) } }) { Icon(Icons.Filled.Download, "下载") }
            }
        }
    }
}

/** 网络层的英文异常换成一句能看懂的话。 */
fun replayError(e: Throwable, fallback: String): String = when (e) {
    is java.net.UnknownHostException, is java.net.ConnectException -> "没网，或者连不上学校服务器"
    is java.net.SocketTimeoutException -> "连接学校超时，稍后再试"
    is javax.net.ssl.SSLException -> "和学校的加密连接断了，再试一次"
    else -> e.message?.takeIf { it.isNotBlank() } ?: fallback
}

fun formatBytes(bytes: Long): String = when {
    bytes >= 1L shl 30 -> "%.1f GB".format(bytes / (1L shl 30).toDouble())
    bytes >= 1L shl 20 -> "%.0f MB".format(bytes / (1L shl 20).toDouble())
    else -> "${bytes / 1024} KB"
}
