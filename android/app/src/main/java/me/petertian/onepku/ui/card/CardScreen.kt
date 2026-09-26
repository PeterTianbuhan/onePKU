package me.petertian.onepku.ui.card

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
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import me.petertian.onepku.data.card.CardBalance
import me.petertian.onepku.data.card.MonthlyStat
import me.petertian.onepku.data.card.TurnoverRecord
import me.petertian.onepku.data.card.fenToYuan
import me.petertian.onepku.data.repo.CardRepository
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.SectionContent
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

data class CardUiState(
    val refreshing: Boolean = false,
    val balance: UiData<CardBalance> = UiData.Loading,
    val monthly: UiData<MonthlyStat> = UiData.Loading,
    val records: List<TurnoverRecord> = emptyList(),
    val recordsError: String? = null,
    val page: Int = 1,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
)

@HiltViewModel
class CardViewModel @Inject constructor(
    private val repo: CardRepository,
) : ViewModel() {
    private val _ui = MutableStateFlow(CardUiState())
    val ui: StateFlow<CardUiState> = _ui.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _ui.update { it.copy(refreshing = true) }
            coroutineScope {
                val balanceJob = async {
                    try {
                        UiData.Ready(repo.balance(true))
                    } catch (e: Exception) {
                        UiData.Failure(e.message ?: "余额加载失败")
                    }
                }
                val monthlyJob = async {
                    try {
                        UiData.Ready(repo.monthly())
                    } catch (e: Exception) {
                        UiData.Failure(e.message ?: "统计加载失败")
                    }
                }
                val recordsJob = async {
                    try {
                        repo.turnover(1)
                    } catch (e: Exception) {
                        null
                    }
                }
                _ui.update {
                    it.copy(
                        balance = balanceJob.await(),
                        monthly = monthlyJob.await(),
                    )
                }
                val page1 = recordsJob.await()
                _ui.update {
                    it.copy(
                        records = page1?.records ?: emptyList(),
                        recordsError = if (page1 == null) "流水加载失败" else null,
                        page = 1,
                        hasMore = (page1?.pages ?: 1) > 1,
                    )
                }
            }
            _ui.update { it.copy(refreshing = false) }
        }
    }

    fun loadMore() {
        val state = _ui.value
        if (state.loadingMore || !state.hasMore) return
        _ui.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            try {
                val next = repo.turnover(state.page + 1)
                _ui.update {
                    it.copy(
                        records = it.records + next.records,
                        page = next.current.toInt(),
                        hasMore = next.current < next.pages,
                        loadingMore = false,
                    )
                }
            } catch (e: Exception) {
                _ui.update { it.copy(loadingMore = false) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CardScreen(nav: NavHostController, vm: CardViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("校园卡") },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = ui.refreshing,
            onRefresh = vm::refresh,
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item(key = "balance") {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(20.dp)) {
                            Text("卡余额", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(4.dp))
                            SectionContent(data = ui.balance, onRetry = vm::refresh) { b ->
                                Text(
                                    "¥${fenToYuan(b.totalFen)}",
                                    style = MaterialTheme.typography.headlineMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                Spacer(Modifier.height(8.dp))
                                b.accounts.forEach { a ->
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(a.name, style = MaterialTheme.typography.bodySmall)
                                        Text("¥${fenToYuan(a.balanceFen)}", style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                                if (b.holder.isNotBlank()) {
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        "${b.holder} · ${b.cardNumber}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }

                item(key = "monthly") {
                    Card(Modifier.fillMaxWidth()) {
                        SectionContent(data = ui.monthly, onRetry = vm::refresh) { m ->
                            Row(
                                Modifier.fillMaxWidth().padding(20.dp),
                                horizontalArrangement = Arrangement.SpaceEvenly,
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(
                                        "¥${fenToYuan(m.rechargeFen)}",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(
                                        "本月充值",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text(
                                        "¥${fenToYuan(m.expenseFen)}",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                    Text(
                                        "本月支出（消费类）",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }

                item(key = "records-title") {
                    Text("流水", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }

                if (ui.recordsError != null && ui.records.isEmpty()) {
                    item {
                        Text(ui.recordsError!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }

                items(ui.records, key = { "${it.time}-${it.summary}-${it.amountFen}" }) { r ->
                    Card(Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(r.summary.ifBlank { r.type }, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                                Text(r.time, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(
                                    "¥${fenToYuan(r.amountFen)}",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                Text(
                                    "余 ¥${fenToYuan(r.balanceFen)}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
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
