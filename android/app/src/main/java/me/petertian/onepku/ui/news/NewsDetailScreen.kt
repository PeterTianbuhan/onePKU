package me.petertian.onepku.ui.news

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.OpenInBrowser
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
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
import me.petertian.onepku.data.news.NewsApi
import me.petertian.onepku.data.news.NewsItem
import me.petertian.onepku.data.news.WebSource
import me.petertian.onepku.data.portal.PortalApi
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.HtmlText
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

data class NewsDetailUiState(
    val title: String = "",
    val url: String = "",
    val html: UiData<String> = UiData.Loading,
)

@HiltViewModel
class NewsDetailViewModel @Inject constructor(
    savedState: SavedStateHandle,
    private val portal: PortalApi,
    private val news: NewsApi,
) : ViewModel() {
    private val kind: String = checkNotNull(savedState["kind"])
    private val id: String = savedState.get<String>("id").orEmpty()
    private val url: String = savedState.get<String>("url").orEmpty()
    private val title: String = savedState.get<String>("title").orEmpty()
    private val source: String = savedState.get<String>("source").orEmpty()

    private val _ui = MutableStateFlow(NewsDetailUiState(title = title, url = url))
    val ui: StateFlow<NewsDetailUiState> = _ui.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _ui.value = _ui.value.copy(html = UiData.Loading)
            val result = try {
                if (kind == "portal") {
                    UiData.Ready(portal.noticeDetail(id))
                } else {
                    val webSource = WebSource.valueOf(source)
                    UiData.Ready(
                        news.detail(NewsItem(id = id, source = webSource, title = title, date = "", department = "", url = url)),
                    )
                }
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "正文加载失败")
            }
            _ui.value = _ui.value.copy(html = result)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewsDetailScreen(nav: NavHostController, vm: NewsDetailViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()
    val context = LocalContext.current

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(ui.title, maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    if (ui.url.isNotBlank()) {
                        IconButton(onClick = {
                            runCatching {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ui.url)))
                            }
                        }) {
                            Icon(Icons.Outlined.OpenInBrowser, contentDescription = "原文")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            when (val html = ui.html) {
                is UiData.Loading -> LoadingBox()
                is UiData.Failure -> ErrorBox(html.message, onRetry = vm::load)
                is UiData.Ready -> Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                ) {
                    Text(ui.title, style = MaterialTheme.typography.titleMedium)
                    HtmlText(html.value, modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
    }
}
