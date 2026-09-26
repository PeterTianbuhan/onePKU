package me.petertian.onepku.ui.today

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
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
import javax.inject.Inject

data class TodayUiState(
    val loggedOut: Boolean = false,
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
        if (!auth.hasCredentials()) {
            _ui.update { it.copy(loggedOut = true) }
        } else {
            refresh()
        }
    }

    fun refresh() {
        if (_ui.value.refreshing) return
        _ui.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            coroutineScope {
                val assignmentsJob = async { loadAssignments() }
                val announcementsJob = async { loadAnnouncements() }
                val cardJob = async { loadCard() }
                assignmentsJob.await(); announcementsJob.await(); cardJob.await()
            }
            _ui.update { it.copy(refreshing = false) }
        }
    }

    private suspend fun loadAssignments() {
        if (!auth.isLoggedIn(Service.COURSE) && !auth.hasCredentials()) return
        _ui.update {
            it.copy(
                assignments = try {
                    val list = courses.courses().filter { c -> c.isCurrent }
                    courses.assignments(list)
                        .filter { a -> !a.submitted && (a.deadlineEpochMs ?: Long.MAX_VALUE) >= System.currentTimeMillis() }
                        .sortedBy { a -> a.deadlineEpochMs ?: Long.MAX_VALUE }
                        .let { ready -> UiData.Ready(ready) }
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "作业加载失败")
                },
            )
        }
    }

    private suspend fun loadAnnouncements() {
        if (!auth.isLoggedIn(Service.COURSE) && !auth.hasCredentials()) return
        _ui.update {
            it.copy(
                announcements = try {
                    val list = courses.courses().filter { c -> c.isCurrent }
                    val all = coroutineScope {
                        list.map { c ->
                            async {
                                runCatching { courses.announcements(c.id, c.name) }.getOrElse { emptyList() }
                            }
                        }.flatMap { d -> d.await() }
                    }
                    UiData.Ready(all.sortedByDescending { n -> n.date })
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "通知加载失败")
                },
            )
        }
    }

    private suspend fun loadCard() {
        if (!auth.isLoggedIn(Service.CARD) && !auth.hasCredentials()) return
        _ui.update {
            it.copy(
                cardBalance = try {
                    UiData.Ready(card.balance())
                } catch (e: Exception) {
                    UiData.Failure(e.message ?: "校园卡加载失败")
                },
            )
        }
    }
}
