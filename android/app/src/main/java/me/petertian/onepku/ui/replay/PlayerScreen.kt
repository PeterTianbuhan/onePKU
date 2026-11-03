@file:UnstableOptIn(UnstableApi::class)

package me.petertian.onepku.ui.replay

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.annotation.OptIn as UnstableOptIn
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import androidx.navigation.NavHostController
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import me.petertian.onepku.data.replay.Haoxue
import me.petertian.onepku.data.replay.ReplayStore
import me.petertian.onepku.ui.components.ErrorBox
import me.petertian.onepku.ui.components.LoadingBox
import me.petertian.onepku.ui.components.UiData
import me.petertian.onepku.ui.navigation.back
import javax.inject.Inject

@HiltViewModel
class ReplayPlayerViewModel @Inject constructor(
    savedState: SavedStateHandle,
    val store: ReplayStore,
    @ApplicationContext context: Context,
) : ViewModel() {
    val lesson = Haoxue.Lesson(
        courseId = savedState.get<String>("courseId").orEmpty(),
        episodeId = savedState.get<String>("episodeId").orEmpty(),
        title = savedState.get<String>("title").orEmpty(),
        time = savedState.get<String>("time").orEmpty(),
        courseName = savedState.get<String>("course").orEmpty(),
        room = savedState.get<String>("room").orEmpty(),
    )
    private val key = lesson.key
    private val _meta = MutableStateFlow<UiData<ReplayStore.Meta>>(UiData.Loading)
    val meta: StateFlow<UiData<ReplayStore.Meta>> = _meta.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /** 播放器放在 ViewModel 里，切全屏、转屏都不会重建，进度不丢。 */
    val player: ExoPlayer = ExoPlayer.Builder(context)
        // 往前多缓冲两分钟：课堂录像码率低，多取几段能扛住校园网抖动。
        .setLoadControl(DefaultLoadControl.Builder().setBufferDurationsMs(30_000, 150_000, 2_500, 5_000).build())
        .build()
    private var started = false

    init {
        player.addListener(object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                val cause = generateSequence(e as Throwable) { it.cause }.firstOrNull { it is java.io.IOException }
                _error.value = cause?.let { replayError(it, "这一段没取到") } ?: "播放出错（${e.errorCodeName}）"
            }
        })
        open()
        // 记住看到哪里，下次从这里接着放。
        viewModelScope.launch {
            while (true) {
                delay(10_000)
                if (player.isPlaying) store.savePosition(key, player.currentPosition)
            }
        }
    }

    fun open() = viewModelScope.launch {
        _meta.value = UiData.Loading
        _meta.value = try {
            val meta = store.prepare(lesson)
            if (!started) {
                started = true
                player.setMediaSource(
                    HlsMediaSource.Factory(ReplayDataSource.Factory(store)).createMediaSource(
                        MediaItem.Builder().setUri("${ReplayStore.SCHEME}://$key/index.m3u8")
                            .setMimeType(MimeTypes.APPLICATION_M3U8).build(),
                    ),
                )
                val length = (meta.durations.sum() * 1000).toLong()
                if (meta.positionMs in 1 until length - 10_000) player.seekTo(meta.positionMs)
                player.prepare()
                player.playWhenReady = true
            }
            UiData.Ready(meta)
        } catch (e: Exception) {
            UiData.Failure(replayError(e, "回放打开失败"))
        }
    }

    fun retry() {
        _error.value = null
        player.prepare()
        player.play()
    }

    fun pause() {
        player.pause()
        store.savePosition(key, player.currentPosition)
    }

    override fun onCleared() {
        store.savePosition(key, player.currentPosition)
        player.release()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReplayPlayerScreen(nav: NavHostController, vm: ReplayPlayerViewModel = hiltViewModel()) {
    val meta by vm.meta.collectAsState()
    var fullscreen by rememberSaveable { mutableStateOf(false) }
    FullscreenEffect(fullscreen)
    BackHandler(enabled = fullscreen) { fullscreen = false }

    if (fullscreen) {
        (meta as? UiData.Ready)?.let {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                Player(vm, Modifier.fillMaxSize(), fullscreen) { fullscreen = it }
            }
        }
        return
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(vm.lesson.courseName.ifBlank { "回放" }, maxLines = 1) },
                navigationIcon = { IconButton(onClick = { nav.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black), contentAlignment = Alignment.Center) {
                when (val data = meta) {
                    is UiData.Loading -> LoadingBox(message = "正在取播放列表…")
                    is UiData.Failure -> ErrorBox(data.message, onRetry = vm::open)
                    is UiData.Ready -> Player(vm, Modifier.fillMaxSize(), fullscreen) { fullscreen = it }
                }
            }
            Details(vm)
        }
    }
}

@Composable
private fun Details(vm: ReplayPlayerViewModel) {
    val states by vm.store.states.collectAsState()
    val local = states[vm.lesson.key]
    val ask = rememberNotificationAsk()
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(vm.lesson.title, style = MaterialTheme.typography.titleMedium)
        Text(
            listOf(vm.lesson.time, vm.lesson.room).filter { it.isNotBlank() }.joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (local != null && local.total > 0) {
            LinearProgressIndicator(
                progress = { local.done.toFloat() / local.total },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
        }
        localLabel(local)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
            when {
                local?.downloading == true -> OutlinedButton(onClick = { vm.store.delete(vm.lesson.key) }) { Text("取消下载") }
                local?.complete == true && local.keep -> OutlinedButton(onClick = { vm.store.delete(vm.lesson.key) }) { Text("删除下载") }
                else -> Button(onClick = { ask { vm.store.download(vm.lesson) } }) {
                    Text(if (local?.keep == true) "接着下载" else "下载整节课")
                }
            }
        }
        Text(
            "边看边存：看过的部分不用再下；下载会把剩下的补齐，断网也能看。没点下载的缓存一周不打开就清掉。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun Player(vm: ReplayPlayerViewModel, modifier: Modifier, fullscreen: Boolean, onFullscreen: (Boolean) -> Unit) {
    val error by vm.error.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) vm.pause() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        AndroidView(
            factory = {
                PlayerView(it).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    keepScreenOn = true
                    setShowSubtitleButton(false)
                }
            },
            update = { view ->
                view.player = vm.player
                view.setFullscreenButtonState(fullscreen)
                view.setFullscreenButtonClickListener { onFullscreen(it) }
            },
            onRelease = { it.player = null },
            modifier = Modifier.fillMaxSize(),
        )
        error?.let { message ->
            Column(Modifier.background(Color.Black.copy(alpha = 0.8f)).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(message, color = Color.White, style = MaterialTheme.typography.bodyMedium)
                Button(onClick = vm::retry, modifier = Modifier.padding(top = 8.dp)) { Text("重试") }
            }
        }
    }
}

/** 全屏时横过来、藏起状态栏和导航栏；退出全屏或离开页面时还原。 */
@Composable
private fun FullscreenEffect(fullscreen: Boolean) {
    val view = LocalView.current
    val activity = LocalContext.current as? Activity ?: return
    DisposableEffect(fullscreen) {
        val controller = WindowCompat.getInsetsController(activity.window, view)
        if (fullscreen) {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
