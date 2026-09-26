package me.petertian.onepku.ui.news

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
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
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
import me.petertian.onepku.data.news.NewsApi
import me.petertian.onepku.data.news.NewsItem
import me.petertian.onepku.data.news.SchoolNoticeApi
import me.petertian.onepku.data.news.SchoolNoticeItem
import me.petertian.onepku.data.news.WebSource
import me.petertian.onepku.data.repo.DepartmentStore
import me.petertian.onepku.data.portal.NoticeSource
import me.petertian.onepku.data.portal.PortalApi
import me.petertian.onepku.data.portal.PortalNotice
import me.petertian.onepku.ui.components.EmptyBox
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.Routes
import javax.inject.Inject

sealed interface NewsEntry {
    val title: String
    val date: String
    val department: String

    data class Portal(val notice: PortalNotice) : NewsEntry {
        override val title get() = notice.title
        override val date get() = notice.date
        override val department get() = notice.department
    }

    data class Web(val item: NewsItem) : NewsEntry {
        override val title get() = item.title
        override val date get() = item.date
        override val department get() = item.department
    }
}

enum class NewsTab(val label: String) {
    SCHOOL("学校"), DEPARTMENT("部门"), OUR_SCHOOL("本院"), DEAN("教务部"), LIBRARY("图书馆"),
}

data class NewsUiState(
    val tab: NewsTab = NewsTab.SCHOOL,
    val items: UiData<List<NewsEntry>> = UiData.Loading,
    val school: String? = null,
    val fromPortal: Boolean = false,
    val page: Int = 1,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
)

@HiltViewModel
class NewsViewModel @Inject constructor(
    private val portal: PortalApi,
    private val news: NewsApi,
    private val schoolNotices: SchoolNoticeApi,
    private val departments: DepartmentStore,
) : ViewModel() {

    private val _ui = MutableStateFlow(NewsUiState())
    val ui: StateFlow<NewsUiState> = _ui.asStateFlow()

    init { load(NewsTab.SCHOOL) }

    fun load(tab: NewsTab) {
        _ui.update { it.copy(tab = tab, items = UiData.Loading, page = 1, hasMore = false) }
        viewModelScope.launch {
            val result = try {
                val (items, hasMore) = fetch(tab, 1)
                _ui.update { it.copy(page = 1, hasMore = hasMore) }
                UiData.Ready(items)
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "通知加载失败")
            }
            _ui.update { it.copy(items = result) }
        }
    }

    fun refresh() = load(_ui.value.tab)

    fun loadMore() {
        val state = _ui.value
        if (state.loadingMore || !state.hasMore) return
        if (state.tab != NewsTab.SCHOOL && state.tab != NewsTab.DEPARTMENT) return
        val next = state.page + 1
        _ui.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            try {
                val (items, hasMore) = fetch(state.tab, next)
                _ui.update {
                    it.copy(
                        items = UiData.Ready((it.items.orNull() ?: emptyList()) + items),
                        page = next,
                        hasMore = hasMore,
                        loadingMore = false,
                    )
                }
            } catch (e: Exception) {
                _ui.update { it.copy(loadingMore = false) }
            }
        }
    }

    private suspend fun fetch(tab: NewsTab, page: Int): Pair<List<NewsEntry>, Boolean> = when (tab) {
        NewsTab.SCHOOL -> portal.notices(NoticeSource.SCHOOL, page)
            .let { it.items.map(NewsEntry::Portal) to it.hasMore }
        NewsTab.DEPARTMENT -> portal.notices(NoticeSource.DEPARTMENT, page)
            .let { it.items.map(NewsEntry::Portal) to it.hasMore }
        NewsTab.DEAN -> news.list(WebSource.DEAN).map(NewsEntry::Web) to false
        NewsTab.OUR_SCHOOL -> {
            val notices = schoolNotices.list(departments.current() ?: "")
            _ui.update {
                it.copy(
                    school = notices.school,
                    fromPortal = notices.items.any { e -> e is SchoolNoticeItem.FromPortal },
                )
            }
            notices.items.map { entry ->
                when (entry) {
                    is SchoolNoticeItem.FromSite -> NewsEntry.Web(entry.item)
                    is SchoolNoticeItem.FromPortal -> NewsEntry.Portal(entry.notice)
                }
            } to false
        }
        NewsTab.LIBRARY -> news.list(WebSource.LIBRARY).map(NewsEntry::Web) to false
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewsScreen(nav: NavHostController, vm: NewsViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()
    val tabs = NewsTab.entries

    Scaffold(topBar = { TopAppBar(title = { Text("通知") }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            ScrollableTabRow(selectedTabIndex = tabs.indexOf(ui.tab), edgePadding = 12.dp) {
                tabs.forEach { tab ->
                    Tab(
                        selected = ui.tab == tab,
                        onClick = { vm.load(tab) },
                        text = {
                            Text(
                                if (tab == NewsTab.OUR_SCHOOL && ui.school != null &&
                                    ui.school != "信息科学技术学院"
                                ) ui.school ?: tab.label else tab.label,
                            )
                        },
                    )
                }
            }
            if (ui.tab == NewsTab.OUR_SCHOOL && ui.fromPortal) {
                Text(
                    "本院官网暂未适配,以下来自校内门户部门通知。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            when (val data = ui.items) {
                is UiData.Loading -> LoadingBox()
                is UiData.Failure -> ErrorBox(data.message, onRetry = vm::refresh)
                is UiData.Ready -> {
                    if (data.value.isEmpty()) {
                        EmptyBox("暂无通知")
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(data.value, key = { entry ->
                                when (entry) {
                                    is NewsEntry.Portal -> "p-${entry.notice.id}"
                                    is NewsEntry.Web -> entry.item.id
                                }
                            }) { entry ->
                                NewsCard(entry) {
                                    when (entry) {
                                        is NewsEntry.Portal -> nav.navigate(
                                            Routes.newsDetail("portal", entry.notice.id, entry.notice.url, entry.title, entry.department),
                                        )
                                        is NewsEntry.Web -> nav.navigate(
                                            Routes.newsDetail("web", "", entry.item.url, entry.title, entry.item.source.name),
                                        )
                                    }
                                }
                            }
                            if (ui.hasMore) {
                                item {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                                        TextButton(onClick = vm::loadMore, enabled = !ui.loadingMore) {
                                            Text(if (ui.loadingMore) "加载中…" else "加载更多")
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

@Composable
private fun NewsCard(entry: NewsEntry, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(16.dp)) {
            Text(entry.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2)
            Row(Modifier.padding(top = 4.dp)) {
                Text(
                    listOf(entry.department, entry.date).filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (entry is NewsEntry.Web && entry.item.location.isNotBlank()) {
                Text(
                    "地点:${entry.item.location}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
