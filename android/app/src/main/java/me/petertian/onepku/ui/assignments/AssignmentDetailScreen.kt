package me.petertian.onepku.ui.assignments

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import me.petertian.onepku.data.course.AssignmentDetail
import me.petertian.onepku.data.course.Attachment
import me.petertian.onepku.data.course.FeedbackAttempt
import me.petertian.onepku.data.course.SubmissionOutcome
import me.petertian.onepku.data.repo.CourseRepository
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.formatDateTime
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.openFile
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.back
import me.petertian.onepku.ui.today.deadlineLabel
import java.io.File
import javax.inject.Inject

data class PendingSubmit(val uri: android.net.Uri, val name: String, val sizeBytes: Long)

data class AssignmentDetailUiState(
    val title: String = "",
    val detail: UiData<AssignmentDetail> = UiData.Loading,
    val attempts: UiData<List<FeedbackAttempt>> = UiData.Loading,
    /** 学校提交记录或成绩中心显示已提交;为真时不再显示截止时间。 */
    val submitted: Boolean = false,
    /** 当前尝试的提交时刻;学校页面没给出时为空,不拿截止时间冒充。 */
    val submittedAtEpochMs: Long? = null,
    val pending: PendingSubmit? = null,
    val submitting: Boolean = false,
    /** 正在取回预览的文件地址;非空时该行显示"打开中…"。 */
    val openingUrl: String? = null,
    val submitResult: SubmissionOutcome? = null,
)

@HiltViewModel
class AssignmentDetailViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val repo: CourseRepository,
) : ViewModel() {
    private val courseId: String = checkNotNull(savedState["courseId"])
    private val contentId: String = checkNotNull(savedState["contentId"])
    private val title: String = savedState.get<String>("title").orEmpty()

    private val _ui = MutableStateFlow(AssignmentDetailUiState(title = title))
    val ui: StateFlow<AssignmentDetailUiState> = _ui.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            coroutineScope {
                var detailState: UiData<AssignmentDetail> = UiData.Loading
                var submitted = false
                var submittedAt: Long? = null
                val detailJob = async {
                    try {
                        // 一次抓取同时得到作业详情与当前尝试的提交情况。
                        val (assignment, snapshot) = repo.assignmentOverview(courseId, contentId)
                        detailState = UiData.Ready(assignment)
                        submitted = snapshot.submitted
                        submittedAt = snapshot.submittedAtEpochMs
                    } catch (e: Exception) {
                        detailState = UiData.Failure(e.message ?: "作业详情加载失败")
                    }
                }
                val attemptsJob = async {
                    try {
                        UiData.Ready(repo.attempts(courseId, contentId))
                    } catch (e: Exception) {
                        UiData.Failure(e.message ?: "提交记录加载失败")
                    }
                }
                detailJob.await()
                val attemptsState = attemptsJob.await()
                // 与作业列表同一口径:当前尝试或提交记录任一显示已提交,就算已提交。
                val isSubmitted = submitted ||
                    (attemptsState as? UiData.Ready)?.value?.isNotEmpty() == true
                _ui.update {
                    it.copy(
                        detail = detailState,
                        submitted = isSubmitted,
                        submittedAtEpochMs = submittedAt,
                        attempts = attemptsState,
                    )
                }
            }
        }
    }

    /** 点开已提交的文件:取回缓存后交给系统查看器;同名文件不重复下载。 */
    fun openSubmission(file: Attachment, onDone: (File) -> Unit, onError: (String) -> Unit) {
        if (_ui.value.openingUrl != null) return
        _ui.update { it.copy(openingUrl = file.url) }
        viewModelScope.launch {
            try {
                onDone(repo.cachedFile(file))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                onError("无法打开 ${file.name}:${e.message ?: "网络或学校页面变动"}")
            }
            _ui.update { it.copy(openingUrl = null) }
        }
    }

    fun pickFile(uri: android.net.Uri, name: String, sizeBytes: Long) {
        _ui.update { it.copy(submitResult = null, pending = PendingSubmit(uri, name, sizeBytes)) }
    }

    fun cancelPending() {
        _ui.update { it.copy(pending = null) }
    }

    /** 用户明确确认后才上传;失败不自动重发。 */
    fun confirmSubmit() {
        val pending = _ui.value.pending ?: return
        if (_ui.value.submitting) return
        _ui.update { it.copy(submitting = true, pending = null) }
        viewModelScope.launch {
            val outcome = try {
                repo.submitAssignment(courseId, contentId, pending.uri, pending.name)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                SubmissionOutcome.Unverified(e.message ?: "提交失败,学校记录未确认")
            }
            _ui.update { it.copy(submitting = false, submitResult = outcome) }
            load()
        }
    }

    fun dismissResult() = _ui.update { it.copy(submitResult = null) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssignmentDetailScreen(nav: NavHostController, vm: AssignmentDetailViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val (name, size) = queryDocument(context, uri)
            vm.pickFile(uri, name, size)
        }
    }

    ui.pending?.let { pending ->
        PendingSubmitDialog(
            pending = pending,
            onDismiss = vm::cancelPending,
            onConfirm = vm::confirmSubmit,
        )
    }
    ui.submitResult?.let { result ->
        SubmitResultDialog(result = result, onDismiss = vm::dismissResult)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("作业详情", maxLines = 1) },
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
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                when (val d = ui.detail) {
                    is UiData.Loading -> Row(
                        Modifier.fillMaxWidth().padding(24.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) { Text("加载中…", style = MaterialTheme.typography.bodySmall) }
                    is UiData.Failure -> Text(
                        d.message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    is UiData.Ready -> DetailCard(d.value, ui.title, ui.submitted, ui.submittedAtEpochMs)
                }
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Button(
                            onClick = { picker.launch(arrayOf("*/*")) },
                            enabled = !ui.submitting,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(if (ui.submitting) "提交中…" else "提交作业")
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "限单个文件,大小不超过 25 MB;上传后应用将重新读取提交记录并核对回执文件的 SHA-256,核对失败不会自动重发",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            item {
                Text("提交记录", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }

            when (val attempts = ui.attempts) {
                is UiData.Loading -> item {
                    Text("提交记录加载中…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                is UiData.Failure -> item {
                    Text(attempts.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                is UiData.Ready -> {
                    if (attempts.value.isEmpty()) {
                        item {
                            Text(
                                "暂无提交记录",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        items(attempts.value, key = { it.id }) { attempt ->
                            AttemptCard(attempt, ui.openingUrl) { file ->
                                vm.openSubmission(
                                    file,
                                    onDone = { openFile(context, it) },
                                    onError = { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() },
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
private fun DetailCard(detail: AssignmentDetail, fallbackTitle: String, submitted: Boolean, submittedAtEpochMs: Long?) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(
                detail.title.ifEmpty { fallbackTitle },
                style = MaterialTheme.typography.titleLarge,
            )
            Spacer(Modifier.height(8.dp))
            // 已提交就不显示截止时间——交了之后那个时间没有意义;页面上给了提交时刻才报一句。
            if (submitted) {
                submittedAtEpochMs?.let {
                    Text(
                        "已于 ${formatDateTime(it)} 提交",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        "截止:${detail.deadlineRaw ?: "未知"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        deadlineLabel(detail.deadlineEpochMs),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            if (detail.instructions.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(detail.instructions, style = MaterialTheme.typography.bodyMedium)
            }
            if (detail.attachments.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text("附件", style = MaterialTheme.typography.labelLarge)
                detail.attachments.forEach { a ->
                    Text("· ${a.name}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun PendingSubmitDialog(pending: PendingSubmit, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("确认提交作业") },
        text = {
            Column {
                Text("提交后学校将新增一次尝试记录,请核对以下内容")
                Spacer(Modifier.height(12.dp))
                Text("文件:${pending.name}", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "大小:${"%.2f".format(java.util.Locale.US, pending.sizeBytes / 1024.0 / 1024.0)} MB",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (pending.sizeBytes > 25L * 1024 * 1024) {
                    Spacer(Modifier.height(8.dp))
                    Text("超过 25 MB 上限,无法提交", color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = pending.sizeBytes in 1..(25L * 1024 * 1024),
            ) { Text("提交给学校") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun SubmitResultDialog(result: SubmissionOutcome, onDismiss: () -> Unit) {
    val confirmed = result is SubmissionOutcome.Confirmed
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (confirmed) "提交已核对" else "提交待核对") },
        text = {
            Text(
                when (result) {
                    is SubmissionOutcome.Confirmed ->
                        "学校回执「${result.fileName}」与本地文件校验值一致,提交已确认"
                    is SubmissionOutcome.Unverified ->
                        "${result.reason}\n请在教学网原页面核对,勿重复提交"
                },
            )
        },
        confirmButton = { Button(onClick = onDismiss) { Text("知道了") } },
    )
}

private fun queryDocument(context: android.content.Context, uri: android.net.Uri): Pair<String, Long> {
    var name = "submission"
    var size = 0L
    context.contentResolver.query(uri, null, null, null, null)?.use { c ->
        if (c.moveToFirst()) {
            c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                .takeIf { it >= 0 }?.let { name = c.getString(it) ?: name }
            c.getColumnIndex(android.provider.OpenableColumns.SIZE)
                .takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
        }
    }
    return name to size
}

@Composable
private fun AttemptCard(
    attempt: FeedbackAttempt,
    openingUrl: String?,
    onOpen: (Attachment) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(attempt.label.ifEmpty { "提交" }, style = MaterialTheme.typography.titleSmall)
                if (attempt.score != null) {
                    Text(
                        attempt.score + (attempt.pointsPossible?.let { " / $it" } ?: ""),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Text("未评分", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (!attempt.feedback.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                Text("评语:${attempt.feedback}", style = MaterialTheme.typography.bodySmall)
            }
            if (attempt.files.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                attempt.files.forEach { f ->
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable { onOpen(f) },
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            f.name,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                            maxLines = 1,
                        )
                        if (openingUrl == f.url) {
                            Text(
                                "打开中…",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
