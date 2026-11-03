package me.petertian.onepku.data.replay

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.petertian.onepku.MainActivity
import me.petertian.onepku.ui.replay.formatSpeed
import javax.inject.Inject

/** 下载回放时撑住进程的前台服务；下载本身在 [ReplayStore] 里跑，这里只管通知和收尾。 */
@AndroidEntryPoint
class ReplayDownloadService : Service() {
    @Inject lateinit var store: ReplayStore

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loop: Job? = null
    private var lastStart = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "回放下载", NotificationManager.IMPORTANCE_LOW))
        }
        ServiceCompat.startForeground(
            this, ID, notification("准备下载", 0, 0),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        lastStart = startId
        if (loop?.isActive != true) {
            loop = scope.launch {
                // 等下载协程起来，再按它们的进度刷新通知，全部结束就退出。
                delay(500)
                var last = store.received()
                while (store.active()) {
                    val now = store.received()
                    val speed = now - last
                    last = now
                    val running = store.states.value.values.filter { it.downloading }
                    val done = running.sumOf { it.done }
                    val total = running.sumOf { it.total }
                    val title = running.singleOrNull()?.lesson?.let { "${it.courseName} · ${it.title}" }
                        ?: "正在下载 ${running.size} 节回放"
                    manager.notify(ID, notification(title, done, total, speed))
                    delay(1000)
                }
                val failed = store.states.value.values.count { it.keep && it.error != null && !it.complete }
                ServiceCompat.stopForeground(this@ReplayDownloadService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                if (failed > 0) manager.notify(ID + 1, finished("$failed 节回放没下完，打开 OnePKU 重试"))
                stopSelf(lastStart)
            }
        }
        return START_NOT_STICKY
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE,
    )

    private fun notification(title: String, done: Int, total: Int, speed: Long = 0) =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(
                if (total == 0) "正在取播放列表"
                else "$done / $total 段" + if (speed > 0) " · ${formatSpeed(speed)}" else "",
            )
            .setProgress(total, done, total == 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .build()

    private fun finished(text: String) =
        NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("回放下载")
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private companion object {
        const val CHANNEL = "replay_download"
        const val ID = 4201
    }
}
