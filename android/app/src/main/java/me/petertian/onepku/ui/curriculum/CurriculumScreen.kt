package me.petertian.onepku.ui.curriculum

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
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
import me.petertian.onepku.data.curriculum.CurriculumEngine
import me.petertian.onepku.data.curriculum.CurriculumEngine.MatchedCourse
import me.petertian.onepku.data.curriculum.CurriculumEngine.Progress
import me.petertian.onepku.data.curriculum.CurriculumEngine.Section
import me.petertian.onepku.data.curriculum.CurriculumProfileStore
import me.petertian.onepku.data.curriculum.CurriculumRepository
import me.petertian.onepku.data.curriculum.Plan
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.Routes
import me.petertian.onepku.ui.navigation.back
import kotlin.math.roundToInt
import javax.inject.Inject

/** 点课程卡弹出的编辑框的初始值。 */
data class CourseDraft(
    val name: String,
    val credits: Double?,
    val sectionId: String?,
    /** 已有手动归类,可以给回"恢复自动判断"。 */
    val pinned: Boolean,
)

data class CurriculumUiState(
    val content: UiData<Pair<Plan, Progress>> = UiData.Loading,
    val planTitle: String = "",
    val hasProfile: Boolean = false,
    val editing: CourseDraft? = null,
)

/** 归入清单里的"撤销手动归类"用的哨兵,不会与真实的系列 id 冲突。 */
private const val UNPIN = "__auto__"

@HiltViewModel
class CurriculumViewModel @Inject constructor(
    private val repo: CurriculumRepository,
    private val profiles: CurriculumProfileStore,
) : ViewModel() {
    private val _ui = MutableStateFlow(CurriculumUiState())
    val ui: StateFlow<CurriculumUiState> = _ui.asStateFlow()

    init { reload() }

    /** silent = 保留上一次结果,不闪 loading。 */
    fun reload(silent: Boolean = false) {
        val planId = profiles.current().planId
        if (planId.isNullOrEmpty()) {
            _ui.update { it.copy(hasProfile = false, content = UiData.Loading, planTitle = "") }
            return
        }
        if (!silent) _ui.update { it.copy(hasProfile = true, content = UiData.Loading) }
        viewModelScope.launch {
            // index.json 有 700 多 KB,读盘与方案解析都放 IO 线程。
            val title = withContext(Dispatchers.IO) { repo.plans.entry(planId)?.title.orEmpty() }
            _ui.update {
                it.copy(
                    planTitle = title,
                    content = try {
                        UiData.Ready(repo.progress(planId))
                    } catch (e: Exception) {
                        UiData.Failure(e.message ?: "培养方案读取失败")
                    },
                )
            }
        }
    }

    /** 点课程卡进编辑:学分与归类一起改,一次保存生效。 */
    fun openEditor(courseName: String) {
        val progress = (_ui.value.content as? UiData.Ready)?.value?.second ?: return
        val course = findCourse(progress, courseName) ?: return
        val planId = profiles.current().planId
        _ui.update {
            it.copy(
                editing = CourseDraft(
                    name = courseName,
                    credits = course.credits,
                    sectionId = course.sectionId,
                    pinned = profiles.overridesFor(planId)
                        .containsKey(CurriculumEngine.normalizeCourseName(courseName)),
                )
            )
        }
    }

    fun closeEditor() = _ui.update { it.copy(editing = null) }

    /** 没改的那一项不动:不然只是改个学分就会把自动匹配悄悄钉成手动归类。 */
    fun applyEdit(draft: CourseDraft, credits: Double?, sectionId: String?) {
        if (credits != draft.credits) profiles.setManualCredit(draft.name, credits)
        when {
            sectionId == UNPIN -> profiles.setOverride(draft.name, null)
            sectionId != draft.sectionId -> profiles.setOverride(draft.name, sectionId)
        }
        closeEditor()
        reload(silent = true)
    }

    fun choices(): List<Pair<String, String>> =
        (_ui.value.content as? UiData.Ready)?.let { CurriculumEngine.sectionChoices(it.value.second) } ?: emptyList()
}

/** 在系列树、待确认与不计入里找到这门课当前的样子。 */
private fun findCourse(progress: Progress, courseName: String): MatchedCourse? {
    fun walk(s: Section): List<MatchedCourse> =
        s.courses + s.inProgressCourses + s.children.flatMap { walk(it) }
    return (progress.sections.flatMap { walk(it) } + progress.pending + progress.ignored)
        .firstOrNull { it.name == courseName }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CurriculumScreen(nav: NavHostController, vm: CurriculumViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    // 从"选择方案"页返回时重新计算完成度。
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) vm.reload()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    ui.editing?.let { draft ->
        CourseEditor(
            draft = draft,
            choices = vm.choices(),
            onDismiss = vm::closeEditor,
            onSave = { credits, sectionId -> vm.applyEdit(draft, credits, sectionId) },
        )
    }

    // 重新计算完成度时保持当前页,归入一门课后不会跳回第一页。
    var lastPage by rememberSaveable { mutableIntStateOf(0) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(ui.planTitle.ifBlank { "培养方案" }, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    IconButton(onClick = { nav.navigate(Routes.CURRICULUM_PROFILE) }) {
                        Icon(Icons.Outlined.Settings, contentDescription = "选择方案")
                    }
                },
            )
        },
    ) { padding ->
        when (val data = ui.content) {
            is UiData.Loading -> if (ui.hasProfile) LoadingBox(message = "方案读取中…") else NoProfile(padding, nav)
            is UiData.Failure -> ErrorBox(data.message, onRetry = { vm.reload() })
            is UiData.Ready -> ProgressPager(
                progress = data.value.second,
                padding = padding,
                vm = vm,
                startPage = lastPage,
                onStartPageChange = { lastPage = it },
            )
        }
    }
}

@Composable
private fun NoProfile(padding: PaddingValues, nav: NavHostController) {
    Column(
        Modifier.padding(padding).fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("尚未选择培养方案", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "会根据成绩与在修课程推断年级和专业,也可以自己选。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(20.dp))
        Button(onClick = { nav.navigate(Routes.CURRICULUM_PROFILE) }) { Text("开始选择") }
    }
}

@Composable
private fun ProgressPager(
    progress: Progress,
    padding: PaddingValues,
    vm: CurriculumViewModel,
    startPage: Int,
    onStartPageChange: (Int) -> Unit,
) {
    // 第一页毕业总学分,之后每个大类一页,最后按需确认页收尾。
    val titles = buildList {
        add("毕业总学分")
        progress.sections.forEach { add(it.name) }
        if (progress.pending.isNotEmpty() || progress.ignored.isNotEmpty()) add("待确认")
    }
    // 归入一门课后会重新计算完成度,页面不能跳回第一页,所以页码记在调用方。
    val pagerState = rememberPagerState(
        initialPage = startPage.coerceIn(0, maxOf(0, titles.size - 1)),
        pageCount = { titles.size },
    )
    LaunchedEffect(pagerState.currentPage) { onStartPageChange(pagerState.currentPage) }

    Column(Modifier.padding(padding).fillMaxSize()) {
        Text(
            titles.getOrElse(pagerState.currentPage) { "" },
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        )
        PageIndicator(pagerState.currentPage, titles.size)
        HorizontalPager(state = pagerState, modifier = Modifier.fillMaxSize()) { page ->
            when {
                page == 0 -> TotalPage(progress, vm)
                page <= progress.sections.size -> SectionPage(progress.sections[page - 1], vm)
                else -> PendingPage(progress, vm)
            }
        }
    }
}

/** 灰色横条 + 随页面滑动的主题色短线。 */
@Composable
private fun PageIndicator(index: Int, count: Int) {
    if (count <= 1) return
    var trackWidth by remember { mutableFloatStateOf(0f) }
    val density = LocalDensity.current
    val segment = if (count > 0) trackWidth / count else 0f
    Box(
        Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 10.dp)
            .onSizeChanged { trackWidth = it.width.toFloat() }
            .height(4.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
    ) {
        Box(
            Modifier
                .offset { IntOffset((segment * index + segment * 0.2f).roundToInt(), 0) }
                .width(with(density) { ((segment * 0.6f).coerceAtLeast(20f)).toDp() })
                .fillMaxHeight()
                .background(MaterialTheme.colorScheme.primary, CircleShape),
        )
    }
}

@Composable
private fun TotalPage(progress: Progress, vm: CurriculumViewModel) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            RingHeader(
                value = progress.earned,
                pending = progress.inProgress,
                target = progress.required,
                unit = "学分",
                requirement = progress.plan.totalCredits?.let {
                    if (it.max > it.min) "${fmt(it.min)}～${fmt(it.max)} 学分" else "${fmt(it.min)} 学分"
                },
                gap = progress.required?.let { maxOf(0.0, it - progress.earned - progress.inProgress) },
            )
        }
        if (progress.required == null) {
            item {
                Text(
                    "这份方案没有明确写出毕业总学分,因此只显示已获学分,不显示完成比例。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
        }
        if (progress.unknownCredits > 0) {
            item {
                Text(
                    "${progress.unknownCredits} 门课的学分未知,未计入合计。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("各大类", style = MaterialTheme.typography.titleSmall)
                    progress.sections.forEach { SectionBar(it) }
                }
            }
        }
        courseLists(counted(progress.sections), inProgressOf(progress.sections), showOwner = true, vm = vm)
    }
}

@Composable
private fun SectionPage(section: Section, vm: CurriculumViewModel) {
    val value = valueOf(section)
    val pending = pendingOf(section)
    val gap = if (section.unit == "学时") null else section.min?.let { maxOf(0.0, it - value - pending) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            RingHeader(
                value = value,
                pending = pending,
                target = section.min,
                unit = section.unit ?: "学分",
                requirement = section.requirement,
                gap = gap,
            )
        }
        section.note?.let {
            item {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (section.children.isNotEmpty()) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("子系列", style = MaterialTheme.typography.titleSmall)
                        section.children.forEach { SectionBar(it) }
                    }
                }
            }
        }
        courseLists(
            counted(listOf(section)),
            inProgressOf(listOf(section)),
            showOwner = section.children.isNotEmpty(),
            vm = vm,
        )
    }
}

/** 圆环居中,数值、缺口与要求依次写在下方;大类页与子系列页共用同一套排版。 */
@Composable
private fun RingHeader(
    value: Double,
    pending: Double,
    target: Double?,
    unit: String,
    requirement: String?,
    gap: Double?,
) {
    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        CurriculumRing(value, pending, target)
        Text(
            buildString {
                append("已修 ${fmt(value)}")
                if (pending > 0) append(" + 在修 ${fmt(pending)}")
                target?.let { append(" / ${fmt(it)} $unit") } ?: append(" $unit")
            },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )
        gap?.let {
            Text(
                if (it <= 0.0) "已满足" else "还差 ${fmt(it)} $unit",
                style = MaterialTheme.typography.bodySmall,
                color = if (it <= 0.0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
            )
        }
        requirement?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

private fun fmt(value: Double?): String = CurriculumEngine.fmt(value)

@Composable
private fun PendingPage(progress: Progress, vm: CurriculumViewModel) {
    var showIgnored by remember { mutableStateOf(false) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (progress.pending.isEmpty()) {
            item { Text("没有待确认的课程", style = MaterialTheme.typography.bodyMedium) }
        } else {
            // 整张卡可点,进同一个编辑框;不再在条目里塞一排按钮。
            items(progress.pending, key = { it.key }) { course ->
                CourseRow(course, course.category, vm)
            }
        }
        if (progress.ignored.isNotEmpty()) {
            item {
                Row(
                    Modifier.fillMaxWidth().clickable { showIgnored = !showIgnored }.padding(vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("不计入 ${progress.ignored.size} 门", style = MaterialTheme.typography.titleSmall)
                    Text(
                        if (showIgnored) "收起" else "展开",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            if (showIgnored) {
                items(progress.ignored, key = { "ignored-${it.key}" }) { course ->
                    CourseRow(course, course.category, vm)
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

/** 一门课的编辑框:学分与归类一起改。已识别的课程和待确认的课程用的是同一个框。 */
@Composable
private fun CourseEditor(
    draft: CourseDraft,
    choices: List<Pair<String, String>>,
    onDismiss: () -> Unit,
    onSave: (Double?, String?) -> Unit,
) {
    var text by remember(draft.name) { mutableStateOf(draft.credits?.let { fmt(it) } ?: "") }
    var picked by remember(draft.name) { mutableStateOf(draft.sectionId) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(draft.name, style = MaterialTheme.typography.titleMedium, maxLines = 2) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { raw -> text = raw.filter { it.isDigit() || it == '.' }.take(5) },
                    label = { Text(if (draft.credits == null) "学分（教学网不给,手填）" else "学分") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("归入学分系列", style = MaterialTheme.typography.titleSmall)
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 300.dp)) {
                    items(choices, key = { it.first }) { (id, label) ->
                        ChoiceRow(label, picked == id) { picked = id }
                    }
                    item { ChoiceRow("不计入", picked == CurriculumEngine.IGNORE) { picked = CurriculumEngine.IGNORE } }
                    if (draft.pinned) {
                        item { ChoiceRow("恢复自动判断", picked == UNPIN) { picked = UNPIN } }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text.trimEnd('.').toDoubleOrNull(), picked) }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun SectionBar(section: Section) {
    val value = valueOf(section)
    val pending = pendingOf(section)
    val target = section.min
    val unit = section.unit ?: "学分"
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(section.name, style = MaterialTheme.typography.bodySmall)
            Text(
                buildString {
                    append(fmt(value))
                    if (pending > 0) append(" + ${fmt(pending)}")
                    target?.let { append(" / ${fmt(it)}") }
                    append(" $unit")
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (target != null && target > 0) {
            ProgressTrack(
                fraction = if (target > 0f) (value / target).toFloat() else 0f,
                withPending = ((value + pending) / target).toFloat(),
            )
        }
    }
}

/**
 * 直线进度条。颜色取 Material 进度条的默认轨道色与指示色,画法与圆环一致:
 * 轨道 → 28% 淡色的在修段 → 实色的已修段,只是不再画默认进度条末端的那个小圆点。
 */
@Composable
private fun ProgressTrack(fraction: Float, withPending: Float) {
    val color = ProgressIndicatorDefaults.linearColor
    val trackColor = ProgressIndicatorDefaults.linearTrackColor
    Canvas(Modifier.fillMaxWidth().height(6.dp)) {
        val corner = androidx.compose.ui.geometry.CornerRadius(size.height / 2, size.height / 2)
        fun bar(frac: Float, c: androidx.compose.ui.graphics.Color) {
            if (frac <= 0f) return
            drawRoundRect(
                color = c,
                size = Size(size.width * frac.coerceIn(0f, 1f), size.height),
                cornerRadius = corner,
            )
        }
        bar(1f, trackColor)
        bar(withPending, color.copy(alpha = 0.28f))
        bar(fraction, color)
    }
}

/** 在修与已修两份列表,在修在前;父级页面把子系列的课一并列出,并标注归属。 */
private fun LazyListScope.courseLists(
    courses: List<Pair<MatchedCourse, String>>,
    doing: List<Pair<MatchedCourse, String>>,
    showOwner: Boolean,
    vm: CurriculumViewModel,
) {
    if (courses.isEmpty() && doing.isEmpty()) {
        item {
            Text(
                "这一类还没有计入的课程",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    if (doing.isNotEmpty()) {
        val missing = doing.count { it.first.credits == null }
        item {
            Column(Modifier.fillMaxWidth()) {
                Text("在修课程 ${doing.size} 门", style = MaterialTheme.typography.titleSmall)
                if (missing > 0) {
                    Text(
                        "点课程卡填学分",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
        items(doing, key = { "doing-${it.first.key}" }) { CourseRow(it.first, if (showOwner) it.second else null, vm) }
    }
    if (courses.isNotEmpty()) {
        item { Text("已修课程 ${courses.size} 门", style = MaterialTheme.typography.titleSmall) }
        items(courses, key = { it.first.key }) { CourseRow(it.first, if (showOwner) it.second else null, vm) }
    }
}

/** 系列及其子系列下已计入的课程,附带所属系列名。 */
private fun counted(sections: List<Section>): List<Pair<MatchedCourse, String>> =
    sections.flatMap { s -> s.courses.map { it to s.name } + counted(s.children) }

private fun inProgressOf(sections: List<Section>): List<Pair<MatchedCourse, String>> =
    sections.flatMap { s -> s.inProgressCourses.map { it to s.name } + inProgressOf(s.children) }

@Composable
private fun CourseRow(course: MatchedCourse, note: String? = null, vm: CurriculumViewModel? = null) {
    val click: (() -> Unit)? = vm?.let { editor -> { editor.openEditor(course.name) } }
    Card(
        Modifier.fillMaxWidth().then(if (click == null) Modifier else Modifier.clickable(onClick = click)),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 10.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(course.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                Text(
                    listOfNotNull(note, course.term, course.score.ifBlank { null })
                        .filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                statusLabel(course),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

/** 手填一门课的学分:教学网课程列表没有这个字段,方案里那些行也大多没解析出来。 */
/** 右侧优先显示拿到多少学分,拿不到才退回状态词。 */
private fun statusLabel(course: MatchedCourse): String {
    val credits = course.credits
    if (credits != null && course.status != CurriculumEngine.CourseStatus.FAILED) return "${fmt(credits)} 学分"
    return when (course.status) {
        CurriculumEngine.CourseStatus.IN_PROGRESS -> "在修·待填学分"
        CurriculumEngine.CourseStatus.PASSED -> "已获"
        CurriculumEngine.CourseStatus.FAILED -> "未通过"
        CurriculumEngine.CourseStatus.WITHDRAWN -> "退课"
        CurriculumEngine.CourseStatus.OTHER -> "其他"
    }
}

/** 单位决定度量:按门数的系列看点数,其余看学分。 */
private fun valueOf(section: Section): Double =
    if (section.unit == "门") section.passedCount.toDouble() else section.earned

/** 按门计数的系列不画在修弧——门数和学分不是一个量纲。 */
private fun pendingOf(section: Section): Double =
    if (section.unit == "门") 0.0 else section.inProgress

/** 圆环:已修为实色弧,在修按桌面端配色画成淡色弧延伸,达标换成功色。 */
@Composable
private fun CurriculumRing(value: Double, pending: Double, target: Double?) {
    val done = MaterialTheme.colorScheme.primary
    val success = MaterialTheme.colorScheme.tertiary
    val track = MaterialTheme.colorScheme.surfaceVariant
    val ratio = if (target != null && target > 0) (value / target).toFloat().coerceIn(0f, 1f) else 0f
    val withPending = if (target != null && target > 0) ((value + pending) / target).toFloat().coerceIn(0f, 1f) else 0f
    val reached = target != null && value + pending >= target

    Box(contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(128.dp)) {
            val stroke = 11.dp.toPx()
            val arcSize = Size(size.width - stroke, size.height - stroke)
            val origin = Offset(stroke / 2, stroke / 2)
            fun arc(color: androidx.compose.ui.graphics.Color, sweep: Float) {
                if (sweep <= 0f) return
                drawArc(
                    color = color, startAngle = -90f, sweepAngle = sweep, useCenter = false,
                    topLeft = origin, size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
            }
            arc(track, 360f)
            if (withPending > ratio) arc(done.copy(alpha = 0.28f), 360f * withPending)
            arc(if (reached) success else done, 360f * ratio)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                fmt(value),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = if (reached) success else MaterialTheme.colorScheme.primary,
            )
            target?.let {
                Text(
                    "/ ${fmt(it)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
