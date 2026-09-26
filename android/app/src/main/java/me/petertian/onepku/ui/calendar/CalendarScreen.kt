package me.petertian.onepku.ui.calendar

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.IntSize
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
import me.petertian.onepku.data.calendar.CalendarApi
import me.petertian.onepku.data.calendar.SchoolYear
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.back
import java.io.File
import javax.inject.Inject

data class CalendarUiState(
    val year: SchoolYear = SchoolYear.entries.first(),
    val pdf: UiData<File> = UiData.Loading,
    val page: Int = 0,
    val pageCount: Int = 0,
    val bitmap: Bitmap? = null,
    val rendering: Boolean = false,
)

@HiltViewModel
class CalendarViewModel @Inject constructor(
    private val api: CalendarApi,
) : ViewModel() {

    private val _ui = MutableStateFlow(CalendarUiState())
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    private var renderer: PdfRenderer? = null
    private var pfd: ParcelFileDescriptor? = null

    init { load(SchoolYear.entries.first()) }

    fun load(year: SchoolYear) {
        _ui.update { it.copy(year = year, pdf = UiData.Loading, page = 0, pageCount = 0, bitmap = null) }
        viewModelScope.launch {
            val result = try {
                val file = api.pdf(year)
                withContext(Dispatchers.IO) {
                    closeRenderer()
                    pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                    renderer = PdfRenderer(pfd!!)
                }
                _ui.update { it.copy(pageCount = renderer?.pageCount ?: 0) }
                UiData.Ready(file)
            } catch (e: Exception) {
                UiData.Failure(e.message ?: "校历加载失败")
            }
            _ui.update { it.copy(pdf = result) }
            if (result is UiData.Ready) renderPage(0, 1080)
        }
    }

    fun renderPage(index: Int, targetWidth: Int) {
        val r = renderer ?: return
        if (index < 0 || index >= r.pageCount) return
        _ui.update { it.copy(rendering = true, page = index) }
        viewModelScope.launch {
            val bitmap = withContext(Dispatchers.IO) {
                synchronized(this@CalendarViewModel) {
                    val page = r.openPage(index)
                    val width = targetWidth.coerceAtLeast(720)
                    val height = (width.toLong() * page.height / page.width).toInt()
                    val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                    bmp.eraseColor(android.graphics.Color.WHITE)
                    page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    page.close()
                    bmp
                }
            }
            _ui.update { it.copy(bitmap = bitmap, rendering = false) }
        }
    }

    private fun closeRenderer() {
        synchronized(this) {
            runCatching { renderer?.close() }
            runCatching { pfd?.close() }
            renderer = null
            pfd = null
        }
    }

    override fun onCleared() {
        closeRenderer()
        super.onCleared()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarScreen(nav: NavHostController, vm: CalendarViewModel = hiltViewModel()) {
    val ui by vm.ui.collectAsState()
    val configuration = LocalConfiguration.current
    val targetWidth = configuration.screenWidthDp * 2

    DisposableEffect(Unit) {
        onDispose { }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("校历") },
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
            ) {
                SchoolYear.entries.forEach { y ->
                    FilterChip(selected = ui.year == y, onClick = { vm.load(y) }, label = { Text(y.label) })
                }
            }
            when (val pdf = ui.pdf) {
                is UiData.Loading -> LoadingBox(message = "校历下载中…")
                is UiData.Failure -> ErrorBox(pdf.message, onRetry = { vm.load(ui.year) })
                is UiData.Ready -> {
                    Column(Modifier.fillMaxSize()) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            IconButton(onClick = { vm.renderPage(ui.page - 1, targetWidth) }, enabled = ui.page > 0 && !ui.rendering) {
                                Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "上一页")
                            }
                            Text(
                                "${ui.page + 1} / ${ui.pageCount}",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            IconButton(
                                onClick = { vm.renderPage(ui.page + 1, targetWidth) },
                                enabled = ui.page < ui.pageCount - 1 && !ui.rendering,
                            ) {
                                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "下一页")
                            }
                        }
                        ZoomablePage(
                            page = ui.page,
                            bitmap = ui.bitmap,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
    }
}

/** 双指缩放 + 拖动查看;翻页时复位。 */
@Composable
private fun ZoomablePage(page: Int, bitmap: Bitmap?, modifier: Modifier = Modifier) {
    var scale by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }

    val state = rememberTransformableState { zoomChange, panChange, _ ->
        val next = (scale * zoomChange).coerceIn(1f, 5f)
        if (next <= 1f) {
            scale = 1f
            pan = Offset.Zero
        } else {
            val maxX = viewport.width * (next - 1f) / 2f
            val maxY = viewport.height * (next - 1f) / 2f
            scale = next
            pan = Offset(
                (pan.x + panChange.x * next).coerceIn(-maxX, maxX),
                (pan.y + panChange.y * next).coerceIn(-maxY, maxY),
            )
        }
    }

    LaunchedEffect(page) {
        scale = 1f
        pan = Offset.Zero
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { viewport = it }
            .clipToBounds()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = pan.x
                translationY = pan.y
            }
            .transformable(state),
        contentAlignment = Alignment.Center,
    ) {
        bitmap?.let {
            Image(
                bitmap = it.asImageBitmap(),
                contentDescription = "校历第 ${page + 1} 页",
                modifier = Modifier.fillMaxSize().padding(8.dp),
                contentScale = ContentScale.Fit,
            )
        } ?: LoadingBox(message = "渲染中…")

        if (scale > 1.01f) {
            Surface(
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                shape = MaterialTheme.shapes.small,
                tonalElevation = 2.dp,
            ) {
                TextButton(onClick = { scale = 1f; pan = Offset.Zero }) {
                    Text("重置缩放")
                }
            }
        }
    }
}
