package me.petertian.onepku.data.replay

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import me.petertian.onepku.BuildConfig
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 把播放进度同步到本机配置的边车。没配地址或令牌就什么都不做。
 * 失败只放弃这一次，不抛给播放器。
 * 发出去的只有课次和播放位置，没有统一认证密码、手机令牌或会话。
 */
@Singleton
class ProgressSync @Inject constructor(@ApplicationContext context: Context) {
    private val plain = context.getSharedPreferences("progress_sync", Context.MODE_PRIVATE)
    private val secure: SharedPreferences? = runCatching {
        EncryptedSharedPreferences.create(
            context,
            "onepku_progress",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrNull()
    private val mirrorFile = File(context.filesDir, "progress-sync.json")
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val records = ConcurrentHashMap<String, ProgressRecord>()
    private val dirty = ConcurrentHashMap<String, ProgressRecord>()
    private var debounce: Job? = null
    private val _completed = MutableStateFlow<Set<String>>(emptySet())
    val completed: StateFlow<Set<String>> = _completed.asStateFlow()

    data class Editor(
        val url: String,
        val tokenSet: Boolean,
        val enabled: Boolean,
        val overrideSet: Boolean,
    )

    init {
        loadMirror()?.forEach { records[key(it.courseId, it.episodeId)] = it }
        publish()
    }

    fun editor(): Editor {
        val urlOverride = if (plain.contains(URL)) plain.getString(URL, "").orEmpty() else null
        val tokenOverride = secure?.getString(TOKEN, null)
        val url = urlOverride ?: BuildConfig.PROGRESS_SYNC_URL
        val token = tokenOverride?.takeIf { it.isNotBlank() } ?: BuildConfig.PROGRESS_SYNC_TOKEN
        return Editor(
            url = url,
            tokenSet = token.trim().length >= 24 && token.trim().none { it.isWhitespace() },
            enabled = progressBase(url, token) != null,
            overrideSet = urlOverride != null || !tokenOverride.isNullOrBlank(),
        )
    }

    /** `token` 为 null 时保留已经保存的覆盖令牌。 */
    fun saveOverride(url: String, token: String?) {
        plain.edit().putString(URL, url.trim()).apply()
        if (token != null) secure?.edit()?.putString(TOKEN, token.trim())?.apply()
    }

    fun clearOverride() {
        plain.edit().remove(URL).apply()
        secure?.edit()?.remove(TOKEN)?.apply()
    }

    fun isCompleted(courseId: String, episodeId: String): Boolean =
        _completed.value.contains(key(courseId, episodeId))

    fun refresh() {
        scope.launch { pullAll() }
    }

    suspend fun pullOne(courseId: String, episodeId: String): ProgressRecord? {
        pullAll()
        return records[key(courseId, episodeId)]
    }

    fun note(record: ProgressRecord, flush: Boolean) {
        if (endpoint() == null) return
        val id = key(record.courseId, record.episodeId)
        val merged = mergeProgress(records[id], record.copy(deviceId = deviceId())) ?: return
        records[id] = merged
        dirty[id] = merged
        publish()
        persist()
        if (flush) flushDirty() else schedule()
    }

    fun flush() = flushDirty()

    private fun endpoint(): Pair<String, String>? {
        val base = progressBase(endpointUrl(), endpointToken()) ?: return null
        return base to endpointToken().trim()
    }

    private fun endpointUrl(): String =
        if (plain.contains(URL)) plain.getString(URL, "").orEmpty() else BuildConfig.PROGRESS_SYNC_URL

    private fun endpointToken(): String =
        secure?.getString(TOKEN, "").orEmpty().ifBlank { BuildConfig.PROGRESS_SYNC_TOKEN }

    private fun deviceId(): String {
        plain.getString(DEVICE, null)?.takeIf { it.isNotBlank() }?.let { return it }
        val created = UUID.randomUUID().toString()
        plain.edit().putString(DEVICE, created).apply()
        return created
    }

    private suspend fun pullAll() {
        val (base, token) = endpoint() ?: return
        val remote = withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("$base/v1/progress")
                    .header("Authorization", "Bearer $token")
                    .get()
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    val text = response.body?.string() ?: return@use null
                    json.decodeFromString(Payload.serializer(), text).records
                }
            }.getOrNull()
        } ?: return
        for (record in remote) {
            val id = key(record.courseId, record.episodeId)
            records[id] = mergeProgress(records[id], record) ?: record
        }
        publish()
        persist()
    }

    private fun schedule() {
        debounce?.cancel()
        debounce = scope.launch {
            delay(PUSH_DEBOUNCE_MS)
            flushDirty()
        }
    }

    private fun flushDirty() {
        debounce?.cancel()
        val batch = dirty.values.toList()
        if (batch.isEmpty()) return
        val (base, token) = endpoint() ?: return
        dirty.clear()
        scope.launch {
            val saved = runCatching {
                val body = json.encodeToString(Payload.serializer(), Payload(batch))
                val request = Request.Builder()
                    .url("$base/v1/progress")
                    .header("Authorization", "Bearer $token")
                    .put(body.toRequestBody(JSON))
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    val text = response.body?.string() ?: return@use null
                    json.decodeFromString(Payload.serializer(), text).records
                }
            }.getOrNull()
            if (saved == null) {
                for (record in batch) dirty.putIfAbsent(key(record.courseId, record.episodeId), record)
                return@launch
            }
            for (record in saved) {
                val id = key(record.courseId, record.episodeId)
                records[id] = mergeProgress(records[id], record) ?: record
            }
            publish()
            persist()
        }
    }

    private fun publish() {
        _completed.value = records.values.filter { it.completed }.map { key(it.courseId, it.episodeId) }.toSet()
    }

    private fun loadMirror(): List<ProgressRecord>? = runCatching {
        if (!mirrorFile.isFile) return null
        json.decodeFromString(Payload.serializer(), mirrorFile.readText()).records
    }.getOrNull()

    private fun persist() {
        runCatching {
            val tmp = File(mirrorFile.parentFile, "progress-sync.json.tmp")
            tmp.writeText(json.encodeToString(Payload.serializer(), Payload(records.values.toList())))
            tmp.renameTo(mirrorFile)
        }
    }

    @Serializable
    private data class Payload(val records: List<ProgressRecord> = emptyList())

    companion object {
        const val PUSH_DEBOUNCE_MS = 20_000L
        private const val URL = "url"
        private const val TOKEN = "token"
        private const val DEVICE = "device_id"
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun key(courseId: String, episodeId: String) = "$courseId\u0000$episodeId"
    }
}
