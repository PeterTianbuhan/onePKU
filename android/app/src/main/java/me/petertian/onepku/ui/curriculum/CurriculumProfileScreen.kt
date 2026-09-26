package me.petertian.onepku.ui.curriculum

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
import me.petertian.onepku.data.curriculum.CurriculumEngine
import me.petertian.onepku.data.curriculum.CurriculumEngine.Inference
import me.petertian.onepku.data.curriculum.PlanIndexEntry
import me.petertian.onepku.data.curriculum.CurriculumProfile
import me.petertian.onepku.data.curriculum.CurriculumProfileStore
import me.petertian.onepku.data.curriculum.CurriculumRepository
import me.petertian.onepku.data.repo.TreeholeRepository
import me.petertian.onepku.ui.grades.SmsDialog
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

data class ProfileUiState(
    val inferring: Boolean = false,
    val inference: Inference? = null,
    val inferenceError: String? = null,
    val needSms: Boolean = false,
    val smsInfo: String? = null,
    val cohort: Int? = null,
    val version: Int? = null,
    val school: String? = null,
    val planId: String? = null,
    val secondaryPlanId: String? = null,
    val englishLevel: String? = null,
    val versions: List<Int> = emptyList(),
    val schools: List<String> = emptyList(),
    val plans: List<PlanIndexEntry> = emptyList(),
    /** 当前方案里按方向分列的那些类。 */
    val splits: List<CurriculumEngine.DirectionSplit> = emptyList(),
    /** 学分系列 id → 选中的方向课程组 id。 */
    val directions: Map<String, String> = emptyMap(),
)

@HiltViewModel
class CurriculumProfileViewModel @Inject constructor(
    private val repo: CurriculumRepository,
    private val profiles: CurriculumProfileStore,
    private val treehole: TreeholeRepository,
) : ViewModel() {

    private val _ui = MutableStateFlow(ProfileUiState())
    val ui: StateFlow<ProfileUiState> = _ui.asStateFlow()

    init {
        val saved = profiles.current()
        _ui.update {
            it.copy(
                cohort = saved.cohort,
                planId = saved.planId,
                secondaryPlanId = saved.secondaryPlanId,
                englishLevel = saved.englishLevel,
                directions = profiles.directionsFor(saved.planId),
            )
        }
        // index.json 有 700 多 KB,首次读盘放 IO 线程,避免卡住界面。
        viewModelScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            val preset = saved.planId?.let { repo.plans.entry(it) }
            _ui.update {
                it.copy(
                    versions = repo.plans.versions(),
                    version = it.version ?: preset?.cohort,
                    school = it.school ?: preset?.school,
                )
            }
            refreshLists()
            loadSplits()
            infer()
        }
    }

    /** 选定方案后读它有没有按方向分列的类;读盘放 IO 线程。 */
    private fun loadSplits() {
        val planId = _ui.value.planId
        viewModelScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            val splits = if (planId == null) emptyList() else CurriculumEngine.directionSplits(repo.plans.plan(planId))
            if (_ui.value.planId != planId) return@launch
            _ui.update { it.copy(splits = splits, directions = profiles.directionsFor(planId)) }
        }
    }

    private fun refreshLists() {
        val state = _ui.value
        _ui.update {
            it.copy(
                schools = repo.plans.schools(state.version),
                plans = repo.plans.plansIn(state.version, state.school),
            )
        }
    }

    fun infer() {
        _ui.update { it.copy(inferring = true, inferenceError = null) }
        viewModelScope.launch {
            try {
                val inferred = repo.infer()
                _ui.update { current ->
                    current.copy(
                        inferring = false,
                        inference = inferred,
                        cohort = current.cohort ?: inferred.cohort,
                        version = current.version ?: inferred.version,
                    )
                }
                refreshLists()
            } catch (e: SmsVerificationRequiredException) {
                _ui.update { it.copy(inferring = false, needSms = true, inferenceError = "树洞需要短信验证后才能读取成绩") }
            } catch (e: Exception) {
                _ui.update { it.copy(inferring = false, inferenceError = e.message ?: "推断失败,可手动选择") }
            }
        }
    }

    fun sendSms() {
        viewModelScope.launch {
            _ui.update { it.copy(smsInfo = try { treehole.sendSms() } catch (e: Exception) { e.message }) }
        }
    }

    fun verifySms(code: String) {
        viewModelScope.launch {
            try {
                treehole.verifySms(code)
                _ui.update { it.copy(needSms = false, smsInfo = null) }
                infer()
            } catch (e: Exception) {
                _ui.update { it.copy(smsInfo = e.message) }
            }
        }
    }

    fun dismissSms() = _ui.update { it.copy(needSms = false) }

    fun setVersion(version: Int?) {
        _ui.update { it.copy(version = version, school = null, planId = null) }
        refreshLists()
    }

    fun setSchool(school: String?) {
        _ui.update { it.copy(school = school) }
        refreshLists()
    }

    fun setPlan(id: String?) {
        _ui.update { it.copy(planId = id, directions = if (id == null) emptyMap() else it.directions) }
        loadSplits()
    }

    fun setSecondary(id: String?) = _ui.update { it.copy(secondaryPlanId = id) }

    fun setEnglish(level: String?) = _ui.update { it.copy(englishLevel = level) }

    /** 方向只改草稿,点保存才落盘;传 null 表示不选。 */
    fun setDirection(sectionId: String, groupId: String?) {
        _ui.update {
            it.copy(directions = it.directions.toMutableMap().apply { if (groupId == null) remove(sectionId) else put(sectionId, groupId) })
        }
    }

    /** 直接采用推断给出的候选。 */
    fun applyCandidate(candidate: CurriculumEngine.Candidate) {
        val entry = repo.plans.entry(candidate.id) ?: return
        _ui.update { it.copy(version = entry.cohort, school = entry.school, planId = entry.id) }
        refreshLists()
        loadSplits()
    }

    fun save(onDone: () -> Unit) {
        val state = _ui.value
        val planId = state.planId ?: return
        val saved = profiles.current()
        val prefix = "$planId|"
        profiles.save(
            CurriculumProfile(
                cohort = state.cohort,
                planId = planId,
                secondaryPlanId = state.secondaryPlanId?.takeIf { it != planId },
                englishLevel = state.englishLevel,
                overrides = saved.overrides,
                // 方向按方案隔离,换方案时别的方案的选择要留着。
                directions = saved.directions.filterKeys { !it.startsWith(prefix) } +
                    state.directions.mapKeys { (sectionId, _) -> "$prefix$sectionId" },
                manualCredits = saved.manualCredits,
                inferred = state.inference?.candidates?.isNotEmpty() == true,
            ),
        )
        onDone()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CurriculumProfileScreen(nav: NavHostController, vm: CurriculumProfileViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    if (ui.needSms) {
        SmsDialog(info = ui.smsInfo, onSend = vm::sendSms, onVerify = vm::verifySms, onDismiss = vm::dismissSms)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("选择培养方案") },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { InferenceCard(ui, vm) }
            item { SectionLabel("方案版本") }
            item {
                ChipRow(listOf(null to "全部") + ui.versions.map { it to "${it} 版" }, ui.version, "版本") { v, _ ->
                    vm.setVersion(v)
                }
            }
            item { SectionLabel("院系") }
            item { SchoolDropdown(ui.school, ui.schools, vm::setSchool) }
            item { SectionLabel("专业方案") }
            if (ui.plans.isEmpty()) {
                item {
                    Text(
                        "当前条件下没有可选方案,试试换版本或院系。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                items(ui.plans, key = { "main-${it.id}" }) { entry ->
                    PlanRow(entry, selected = ui.planId == entry.id, onPick = { vm.setPlan(entry.id) })
                }
            }
            // 方案把某一类按方向分列时,不选方向就不知道该按多少学分算。
            ui.splits.forEach { split ->
                item { SectionLabel("${split.name} · 细分方向") }
                item {
                    Text(
                        "方案里这一类按方向分列、没有统一的学分要求,选准才算得对。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                item {
                    ChipRow(split.options.map { it.groupId to it.name }, ui.directions[split.sectionId], "方向") { g, _ ->
                        vm.setDirection(split.sectionId, g)
                    }
                }
            }
            item { SectionLabel("双学位 / 辅修（可选）") }
            item {
                OutlinedButton(onClick = { vm.setSecondary(null) }) { Text("不选") }
            }
            item {
                Text(
                    "在下方列表里点选一份方案作为双学位;它的成绩单独计算归类。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            items(ui.plans, key = { "sec-${it.id}" }) { entry ->
                PlanRow(
                    entry,
                    selected = ui.secondaryPlanId == entry.id,
                    label = "作为双学位",
                    onPick = { vm.setSecondary(if (ui.secondaryPlanId == entry.id) null else entry.id) },
                )
            }
            item { SectionLabel("大学英语分级（可选）") }
            item {
                ChipRow(
                    listOf(null to "不选") + CurriculumEngine.ENGLISH_LEVELS.map { it.id to "${it.label} ${it.credits} 分" },
                    ui.englishLevel,
                    "分级",
                ) { id, _ -> vm.setEnglish(id) }
            }
            item {
                Text(
                    "分级决定“公共必修课”里大学英语要修多少分（8/8/6/4/2，免修获 2 分）。" +
                        "方案把英语单列成一类的就直接定住；折在公共必修课里的，按这份方案给的区间定住，" +
                        "大类和毕业总学分跟着重算。英语专业和留学生按原文不分级，选了也不生效。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = { vm.save { nav.back() } },
                    enabled = ui.planId != null,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("保存") }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@Composable
private fun InferenceCard(ui: ProfileUiState, vm: CurriculumProfileViewModel) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("推断结果", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(6.dp))
            when {
                ui.inferring -> Text("正在按成绩与在修课程推断…", style = MaterialTheme.typography.bodySmall)
                ui.inferenceError != null -> {
                    Text(
                        ui.inferenceError ?: "",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    TextButtonRow("重试推断", vm::infer)
                }
                else -> {
                    ui.inference?.evidence?.forEach {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    ui.inference?.candidates?.takeIf { it.isNotEmpty() }?.let { cands ->
                        Spacer(Modifier.height(8.dp))
                        Text("候选方案", style = MaterialTheme.typography.labelLarge)
                        Spacer(Modifier.height(4.dp))
                        cands.forEach { c ->
                            Text(
                                "${c.title}（重合 ${c.matched}/${c.total} 门）",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.fillMaxWidth().clickable { vm.applyCandidate(c) }.padding(vertical = 8.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun <T> ChipRow(options: List<Pair<T, String>>, selected: T, label: String, onPick: (T, String) -> Unit) {
    // 手机上选项常常有六七个,横向排会挤成两行,一律一行一个纵向排。
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (value, text) ->
            FilterChip(
                selected = value == selected,
                onClick = { onPick(value, text) },
                label = { Text(text, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun TextButtonRow(text: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) { Text(text) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SchoolDropdown(selected: String?, options: List<String>, onPick: (String?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val items = listOf(null to "全部院系") + options.map { it to it }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected ?: "全部院系",
            onValueChange = {},
            readOnly = true,
            label = { Text("院系") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            items.forEach { (value, text) ->
                DropdownMenuItem(
                    text = { Text(text) },
                    onClick = { expanded = false; onPick(value) },
                )
            }
        }
    }
}

@Composable
private fun PlanRow(entry: PlanIndexEntry, selected: Boolean, onPick: () -> Unit, label: String = "作为主方案") {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onPick),
    ) {
        Row(
            Modifier.padding(16.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(entry.title, style = MaterialTheme.typography.bodyMedium)
                Text(
                    buildString {
                        append(entry.school ?: "未标注院系")
                        entry.totalCredits?.let { append(" · 总学分 ${CurriculumEngine.fmt(it.min)}") }
                        if (entry.warnings > 0) append(" · ${entry.warnings} 处解析警告")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (selected) {
                Icon(Icons.Filled.Check, contentDescription = label, tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}
