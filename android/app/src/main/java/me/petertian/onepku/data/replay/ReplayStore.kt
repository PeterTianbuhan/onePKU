package me.petertian.onepku.data.replay

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.repo.withReauth
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 回放的本机分片仓库，播放和下载共用。
 *
 * 每节课一个目录：`meta.json` 记分片时长与录像签名，`<n>.ts` 是已经解密、校验过的分片。
 * 播放器只拿到本机的 `onepku-replay://` 播放列表；它要哪一段，这里就先看本机有没有，
 * 没有再去学校取，取到就存下来。所以边看边存、拖到哪下到哪，点「下载」只是把剩下的补齐，
 * 断网后已存的部分照样能看。学校的签名地址、密钥和令牌只在内存里，不落盘。
 */
@Singleton
class ReplayStore @Inject constructor(
    private val api: HaoxueApi,
    private val auth: AuthManager,
    @ApplicationContext private val context: Context,
) {
    @Serializable
    data class Meta(
        val lesson: Haoxue.Lesson,
        val signature: String,
        val durations: List<Double>,
        val discontinuities: List<Int> = emptyList(),
        /** 用户点了下载：长期保留。没点的只是看过时顺手存下的，一周没打开就清掉。 */
        val keep: Boolean = false,
        val positionMs: Long = 0,
        val opened: Long = 0,
    )

    data class Local(
        val lesson: Haoxue.Lesson?,
        val done: Int,
        val total: Int,
        val bytes: Long,
        val keep: Boolean,
        val downloading: Boolean = false,
        val error: String? = null,
    ) {
        val complete: Boolean get() = total > 0 && done >= total
    }

    private class Remote(val playlist: Hls.Playlist) {
        val keys = ConcurrentHashMap<String, ByteArray>()
    }

    val root: File = File(context.getExternalFilesDir(null) ?: context.filesDir, "replays")
    private val json = Json { ignoreUnknownKeys = true }
    private val metas = ConcurrentHashMap<String, Meta>()
    private val remotes = ConcurrentHashMap<String, Remote>()
    private val locks = ConcurrentHashMap<String, Any>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _states = MutableStateFlow<Map<String, Local>>(emptyMap())
    val states: StateFlow<Map<String, Local>> = _states.asStateFlow()

    init {
        scope.launch { scan() }
    }

    private fun dir(key: String) = File(root, key)
    private fun partFile(key: String, index: Int) = File(dir(key), "$index.ts")

    /** 启动时盘点一次，顺手清掉一周没打开、也没点下载的缓存。 */
    private fun scan() {
        val weekAgo = System.currentTimeMillis() - 7 * 24 * 3600_000L
        val found = mutableMapOf<String, Local>()
        root.listFiles()?.forEach { folder ->
            val meta = readMeta(folder.name)
            if (meta == null || (!meta.keep && meta.opened < weekAgo)) {
                folder.deleteRecursively()
                return@forEach
            }
            found[folder.name] = measure(folder.name, meta)
        }
        _states.update { found + it }
    }

    private fun measure(key: String, meta: Meta): Local {
        val parts = dir(key).listFiles { file -> file.name.endsWith(".ts") }.orEmpty()
        return Local(meta.lesson, parts.size, meta.durations.size, parts.sumOf { it.length() }, meta.keep)
    }

    private fun readMeta(key: String): Meta? = metas[key] ?: runCatching {
        json.decodeFromString(Meta.serializer(), File(dir(key), "meta.json").readText())
    }.getOrNull()?.also { metas[key] = it }

    private fun writeMeta(key: String, meta: Meta) {
        val folder = dir(key)
        if (!folder.isDirectory) return
        val tmp = File(folder, "meta.json.tmp")
        tmp.writeText(json.encodeToString(Meta.serializer(), meta))
        tmp.renameTo(File(folder, "meta.json"))
        metas[key] = meta
    }

    private fun setState(key: String, change: (Local?) -> Local?) = _states.update { all ->
        val next = change(all[key])
        if (next == null) all - key else all + (key to next)
    }

    fun meta(key: String): Meta? = readMeta(key)

    private suspend fun resolve(lesson: Haoxue.Lesson): Remote = withReauth(auth, Service.HAOXUE) {
        withContext(Dispatchers.IO) {
            val source = api.sources(lesson.courseId, lesson.episodeId).first()
            val text = api.media(source.url, 2 * 1024 * 1024).toString(Charsets.UTF_8)
            Remote(Hls.parse(text, source.url))
        }
    }

    /**
     * 打开一节课：已经存全的直接用，不碰网络；否则向学校取一次播放列表。
     * 学校那边录像变了（重新剪辑），旧分片作废；只是签名地址换了，旧分片接着用。
     * 断网但本机有一部分时照样返回，已存的那些能看。
     */
    suspend fun prepare(lesson: Haoxue.Lesson): Meta = withContext(Dispatchers.IO) {
        val key = lesson.key
        val existing = readMeta(key)
        val now = System.currentTimeMillis()
        if (existing != null && measure(key, existing).complete) {
            return@withContext existing.copy(opened = now).also { writeMeta(key, it) }
        }
        val remote = try {
            resolve(lesson)
        } catch (e: Exception) {
            if (existing != null) return@withContext existing
            throw e
        }
        val playlist = remote.playlist
        if (existing != null && existing.signature != playlist.signature) {
            dir(key).listFiles { file -> file.name.endsWith(".ts") }?.forEach { it.delete() }
        }
        dir(key).mkdirs()
        val meta = Meta(
            lesson = lesson,
            signature = playlist.signature,
            durations = playlist.segments.map { it.duration },
            discontinuities = playlist.segments.withIndex().filter { it.value.discontinuity }.map { it.index },
            keep = existing?.keep == true,
            positionMs = existing?.positionMs ?: 0,
            opened = now,
        )
        writeMeta(key, meta)
        remotes[key] = remote
        setState(key) { old -> measure(key, meta).copy(downloading = old?.downloading == true) }
        meta
    }

    fun playlist(key: String): ByteArray {
        val meta = readMeta(key) ?: throw IOException("这节回放还没打开过")
        return Hls.localPlaylist(key, meta.durations, meta.discontinuities.toSet()).toByteArray()
    }

    /** 第 `index` 段的本机文件；没有就现取，取到校验过再落盘。阻塞调用，给加载线程用。 */
    fun part(key: String, index: Int): File {
        val file = partFile(key, index)
        if (file.isFile) return file
        synchronized(locks.computeIfAbsent("$key/$index") { Any() }) {
            if (file.isFile) return file
            val meta = readMeta(key) ?: throw IOException("这节回放还没打开过")
            if (index !in meta.durations.indices) throw IOException("分片序号无效")
            val bytes = fetch(key, meta, index)
            if (!dir(key).isDirectory) throw IOException("这节回放已删除")
            val tmp = File(dir(key), "$index.part")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file)) throw IOException("分片保存失败")
            setState(key) { old ->
                (old ?: measure(key, meta)).let { it.copy(done = it.done + 1, bytes = it.bytes + bytes.size, total = meta.durations.size) }
            }
            return file
        }
    }

    private fun remoteFor(key: String, meta: Meta, fresh: Boolean): Remote {
        if (!fresh) remotes[key]?.let { return it }
        val remote = runBlocking { resolve(meta.lesson) }
        if (remote.playlist.signature != meta.signature) throw IOException("这节回放在学校那边更新了，请返回重新打开")
        remotes[key] = remote
        return remote
    }

    private fun fetch(key: String, meta: Meta, index: Int): ByteArray {
        var fresh = false
        var lastError: Exception? = null
        repeat(4) { attempt ->
            try {
                val remote = remoteFor(key, meta, fresh)
                val segment = remote.playlist.segments[index]
                var bytes = api.media(segment.url, 32 * 1024 * 1024)
                if (segment.keyUrl != null) {
                    val aes = remote.keys.getOrPut(segment.keyUrl) {
                        api.media(segment.keyUrl, 16).also { if (it.size != 16) throw IOException("视频密钥长度无效") }
                    }
                    bytes = Hls.decrypt(aes, segment.iv!!, bytes)
                }
                if (!Hls.isTransportStream(bytes)) throw IOException("学校没有返回完整的视频片段")
                return bytes
            } catch (e: HaoxueApi.MediaDeniedException) {
                // 签名地址或令牌过期：重新向好学要一份播放列表再试。
                lastError = e
                fresh = true
            } catch (e: IOException) {
                lastError = e
                Thread.sleep(500L * (attempt + 1))
            }
        }
        throw lastError as? IOException ?: IOException(lastError?.message ?: "视频片段下载失败")
    }

    fun savePosition(key: String, positionMs: Long) {
        val meta = readMeta(key) ?: return
        writeMeta(key, meta.copy(positionMs = positionMs))
    }

    // ---- 下载 ----

    /** 把一节课剩下的分片补齐，长期保留。进程在后台时由前台服务撑着。 */
    fun download(lesson: Haoxue.Lesson) {
        val key = lesson.key
        if (jobs[key]?.isActive == true) return
        setState(key) { (it ?: Local(lesson, 0, 0, 0, true)).copy(downloading = true, keep = true, error = null) }
        jobs[key] = scope.launch {
            try {
                val meta = prepare(lesson).copy(keep = true)
                writeMeta(key, meta)
                val missing = meta.durations.indices.filterNot { partFile(key, it).isFile }
                val gate = Semaphore(3)
                coroutineScope {
                    missing.map { index -> async { gate.withPermit { part(key, index) } } }.awaitAll()
                }
                setState(key) { it?.copy(downloading = false, keep = true) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                setState(key) { it?.copy(downloading = false, error = me.petertian.onepku.ui.replay.replayError(e, "下载失败")) }
            } finally {
                jobs.remove(key)
            }
        }
        ContextCompat.startForegroundService(context, Intent(context, ReplayDownloadService::class.java))
    }

    fun active(): Boolean = jobs.values.any { it.isActive }

    /** 删掉这节课的本机文件；正在下载就先停。 */
    fun delete(key: String) {
        jobs.remove(key)?.cancel()
        remotes.remove(key)
        metas.remove(key)
        scope.launch {
            dir(key).deleteRecursively()
            setState(key) { null }
        }
    }

    companion object {
        const val SCHEME = "onepku-replay"
    }
}
