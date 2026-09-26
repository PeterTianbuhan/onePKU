package me.petertian.onepku.ui.classroom

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import me.petertian.onepku.data.portal.ClassroomDay
import me.petertian.onepku.data.portal.ClassroomRow
import me.petertian.onepku.data.portal.PortalApi
import me.petertian.onepku.ui.components.EmptyBox
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

data class ClassroomUiState(
    val building: String = PortalApi.BUILDINGS[1],
    val day: ClassroomDay = ClassroomDay.TODAY,
    val rows: UiData<List<ClassroomRow>> = UiData.Loading,
)

@HiltViewModel
class ClassroomViewModel @Inject constructor(
    private val api: PortalApi,
) : ViewModel() {
    private val _ui = MutableStateFlow(ClassroomUiState())
    val ui: StateFlow<ClassroomUiState> = _ui.asStateFlow()

    init { load() }

    fun setBuilding(b: String) {
        _ui.update { it.copy(building = b) }
        load()
    }

    fun setDay(d: ClassroomDay) {
        _ui.update { it.copy(day = d) }
        load()
    }

    fun load() {
        val (building, day) = _ui.value.let { it.building to it.day }
        viewModelScope.launch {
            _ui.update { it.copy(rows = UiData.Loading) }
            val result = try {
                UiData.Ready(api.freeClassrooms(building, day))
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "查询失败")
            }
            _ui.update { it.copy(rows = result) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClassroomScreen(nav: NavHostController, vm: ClassroomViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("空闲教室") },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                var expanded by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                    OutlinedTextField(
                        value = ui.building,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("教学楼") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                        modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).width(120.dp),
                    )
                    ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        PortalApi.BUILDINGS.forEach { b ->
                            DropdownMenuItem(text = { Text(b) }, onClick = {
                                vm.setBuilding(b)
                                expanded = false
                            })
                        }
                    }
                }
                ClassroomDay.entries.forEach { d ->
                    FilterChip(selected = ui.day == d, onClick = { vm.setDay(d) }, label = { Text(d.label) })
                }
            }

            when (val data = ui.rows) {
                is UiData.Loading -> LoadingBox()
                is UiData.Failure -> ErrorBox(data.message, onRetry = vm::load)
                is UiData.Ready -> {
                    if (data.value.isEmpty()) {
                        EmptyBox("没有查到教室数据")
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(data.value, key = { it.room }) { row -> ClassroomCard(row) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ClassroomCard(row: ClassroomRow) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(row.room, style = MaterialTheme.typography.titleSmall)
                Text(
                    "容量 ${row.capacity}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                row.occupied.forEachIndexed { i, occupied ->
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(22.dp)
                            .background(
                                if (occupied) MaterialTheme.colorScheme.error.copy(alpha = 0.75f)
                                else Color(0xFF4CAF50),
                                shape = MaterialTheme.shapes.small,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("${i + 1}", fontSize = 10.sp, color = Color.White)
                    }
                }
            }
        }
    }
}
