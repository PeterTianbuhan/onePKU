package me.petertian.onepku.ui.today

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.card.CardBalance
import me.petertian.onepku.data.course.Announcement
import me.petertian.onepku.data.course.AssignmentSummary
import me.petertian.onepku.data.repo.CardRepository
import me.petertian.onepku.data.repo.CourseRepository
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.components.loadKeepingLast
import javax.inject.Inject

data class TodayUiState(
    val loggedOut: Boolean = false,
    val loginPrompt: String? = null,
    val refreshing: Boolean = false,
    val assignments: UiData<List<AssignmentSummary>> = UiData.Loading,
    val announcements: UiData<List<Announcement>> = UiData.Loading,
    val cardBalance: UiData<CardBalance> = UiData.Loading,
)

@HiltViewModel
class TodayViewModel @Inject constructor(
    private val auth: AuthManager,
    private val courses: CourseRepository,
    private val card: CardRepository,
) : ViewModel() {

    private val _ui = MutableStateFlow(TodayUiState())
    val ui: StateFlow<TodayUiState> = _ui.asStateFlow()

    init {
        load(force = false, silent = false)
    }

    /** 下拉刷新与重试:绕过缓存重新拉取。 */
    fun refresh() = load(force = true, silent = false)

    /** 回到本页时静默刷新:走缓存,只补拉刚作废的条目,不显示刷新指示。 */
    fun refreshQuietly() = load(force = false, silent = true)

    private var job: Job? = null

    private fun load(force: Boolean, silent: Boolean) {
        if (job?.isActive == true) return
        if (!silent) _ui.update { it.copy(refreshing = true) }
        job = viewModelScope.launch {
            val prompts = coroutineScope {
                val assignmentsJob = async { loadAssignments(force) }
                val announcementsJob = async { loadAnnouncements() }
                val cardJob = async { loadCard() }
                listOf(assignmentsJob.await(), announcementsJob.await(), cardJob.await())
            }
            _ui.update { state ->
                val hasData = state.assignments is UiData.Ready ||
                    state.announcements is UiData.Ready ||
                    state.cardBalance is UiData.Ready
                state.copy(
                    refreshing = false,
                    loginPrompt = prompts.firstOrNull { it != null },
                    loggedOut = !hasData && !auth.hasCredentials(),
                )
            }
        }
    }

    private fun promptFor(service: Service, data: UiData<*>, errorPrompt: String?): String? {
        if (errorPrompt != null) return errorPrompt
        return if (!auth.isLoggedIn(service) && data is UiData.Ready) auth.loggedOutPrompt() else null
    }

    private suspend fun loadAssignments(force: Boolean): String? {
        val (data, prompt) = loadKeepingLast(_ui.value.assignments, "作业加载失败") {
            val list = courses.courses(force).filter { c -> c.isCurrent }
            courses.assignments(list, force)
                .filter { a -> !a.submitted && (a.deadlineEpochMs ?: Long.MAX_VALUE) >= System.currentTimeMillis() }
                .sortedBy { a -> a.deadlineEpochMs ?: Long.MAX_VALUE }
        }
        val shown = promptFor(Service.COURSE, data, prompt)
        _ui.update { it.copy(assignments = data) }
        return shown
    }

    private suspend fun loadAnnouncements(): String? {
        val (data, prompt) = loadKeepingLast(_ui.value.announcements, "通知加载失败") {
            val list = courses.courses().filter { c -> c.isCurrent }
            coroutineScope {
                list.map { c ->
                    async {
                        runCatching { courses.announcements(c.id, c.name) }.getOrElse { emptyList() }
                    }
                }.flatMap { d -> d.await() }
            }.sortedByDescending { n -> n.date }
        }
        val shown = promptFor(Service.COURSE, data, prompt)
        _ui.update { it.copy(announcements = data) }
        return shown
    }

    private suspend fun loadCard(): String? {
        val (data, prompt) = loadKeepingLast(_ui.value.cardBalance, "校园卡加载失败") { card.balance() }
        val shown = promptFor(Service.CARD, data, prompt)
        _ui.update { it.copy(cardBalance = data) }
        return shown
    }
}
