package me.petertian.onepku.data.replay

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.repo.withReauth
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton

data class ReplayCourse(val name: String, val lessons: List<Haoxue.Lesson>) {
    val latest: String get() = lessons.firstOrNull()?.time.orEmpty()
}

/**
 * 哪些课有回放。好学「按课程」目录由教师端发布，缺课是常态；「按日期」流是本人的课堂记录，
 * 完整且没有同名歧义。所以主列表来自本机的按日期索引：第一次把最近半年扫一遍存下来，
 * 之后每次只重扫最近 12 天（录像课后才生成）。索引里没有的老课，再按课程名去目录里认领。
 */
@Singleton
class ReplayRepository @Inject constructor(
    private val api: HaoxueApi,
    private val auth: AuthManager,
    @ApplicationContext context: Context,
) {
    @Serializable
    private data class Index(
        val account: String = "",
        /** 已经扫到的最早一天；空串表示还没建起来。 */
        val covers: String = "",
        val checked: Long = 0,
        val days: Map<String, List<Haoxue.Lesson>> = emptyMap(),
    )

    private val file = File(context.filesDir, "replay/index.json")
    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Mutex()
    private var index: Index? = null

    private suspend fun <T> haoxue(block: () -> T): T =
        withReauth(auth, Service.HAOXUE) { withContext(Dispatchers.IO) { block() } }

    private fun load(account: String): Index {
        val saved = runCatching { json.decodeFromString(Index.serializer(), file.readText()) }.getOrNull()
        return if (saved != null && saved.account == account) saved else Index(account = account)
    }

    private fun save(value: Index) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "index.json.tmp")
        tmp.writeText(json.encodeToString(Index.serializer(), value))
        tmp.renameTo(file)
    }

    /** 还没建过索引：第一次要扫半年，界面据此提示要等一会儿。 */
    fun firstSweep(): Boolean = (index ?: load(api.account())).covers.isEmpty()

    /** 全部有回放的课，按最近一节课倒序。 */
    suspend fun courses(force: Boolean = false): List<ReplayCourse> {
        val lessons = refresh(force).days.values.flatten()
        return lessons.groupBy { Haoxue.canonical(it.courseName) }
            .map { (_, rows) -> ReplayCourse(rows.first().courseName, rows.sortedByDescending { it.time }) }
            .sortedByDescending { it.latest }
    }

    /** 教学网课程名 → 这门课的回放。认领不到要说清楚，不能显示成「没有回放」。 */
    suspend fun lessons(name: String, force: Boolean = false): List<Haoxue.Lesson> {
        val dated = Haoxue.lessonsNamed(name, refresh(force).days.values.flatten())
        if (dated.isNotEmpty()) return dated
        return catalog(name)
    }

    private suspend fun catalog(name: String): List<Haoxue.Lesson> {
        val key = Haoxue.normalize(name)
        for (search in Haoxue.searchKeys(name)) {
            val found = mutableListOf<kotlinx.serialization.json.JsonElement>()
            var previous = Int.MAX_VALUE
            for (page in 1..10) {
                val rows = haoxue { api.listCourses(page, search) }
                found += rows
                if (rows.isEmpty() || rows.size < previous) break
                previous = rows.size
            }
            val hits = found.filter { Haoxue.normalize(Haoxue.scalar(it, "course_name")) == key }
            when {
                hits.size > 1 -> throw Haoxue.ApiException("课堂实录有 ${hits.size} 门同名课程，分不清是哪一门，请在好学原站核对")
                hits.size == 1 -> {
                    val course = Haoxue.scalar(hits[0], "course_id")
                    if (course.isEmpty()) break
                    return haoxue { api.episodes(course) }
                        .mapNotNull { Haoxue.lesson(course, name, it) }
                        .sortedByDescending { it.time }
                }
            }
        }
        throw Haoxue.ApiException("课堂实录里没有找到这门课的回放")
    }

    private suspend fun refresh(force: Boolean): Index = lock.withLock {
        // 还没登过课堂实录（老用户升级上来）时先用已存密码登一次，账号指纹才对。
        if (api.account().isEmpty()) {
            if (!auth.hasCredentials()) throw SessionExpiredException("请先登录")
            auth.relogin(Service.HAOXUE)
        }
        val account = api.account()
        var current = index?.takeIf { it.account == account } ?: load(account)
        val now = System.currentTimeMillis() / 1000
        if (!force && current.covers.isNotEmpty() && now - current.checked < TTL_S) {
            index = current
            return current
        }
        // 先单独探一次：令牌过期就在这里重登一次，免得下面十个并行请求各自重登。
        val today = LocalDate.now(ZoneId.of("Asia/Shanghai"))
        haoxue { api.listDate(today.toString(), 1) }
        val days = current.days.toMutableMap()
        var covers = current.covers
        var swept = false
        for (chunk in plan(today, covers).chunked(CHUNK)) {
            val results = coroutineScope {
                chunk.map { date -> async { date to runCatching { day(date) } } }.awaitAll()
            }
            var failed = 0
            for ((date, result) in results) {
                result.onSuccess { rows ->
                    days[date] = rows.distinctBy { it.key }
                    if (covers.isEmpty() || date < covers) covers = date
                    swept = true
                }.onFailure {
                    days.remove(date)
                    failed++
                }
            }
            // 一整批全失败多半是登录失效或断网，别再往下空跑。
            if (failed == chunk.size) {
                if (!swept) throw results.first().second.exceptionOrNull() ?: Haoxue.ApiException("课堂实录暂时读不到")
                break
            }
        }
        current = Index(account, covers, if (swept) now else current.checked, days.filterValues { it.isNotEmpty() })
        if (swept) save(current)
        index = current
        current
    }

    /** 一天的课堂记录；原站每页十行，满十行再取一页。 */
    private suspend fun day(date: String): List<Haoxue.Lesson> {
        val rows = haoxue { api.listDate(date, 1) }.toMutableList()
        if (rows.size >= 10) runCatching { rows += haoxue { api.listDate(date, 2) } }
        return rows.mapNotNull(Haoxue::datedLesson)
    }

    /** 待扫的日子：最近 12 天总要重扫，比已扫下限更早的接着往前补，最远到半年前。 */
    private fun plan(today: LocalDate, covers: String): List<String> {
        val floor = today.minusDays(BACK_DAYS)
        val dates = sortedSetOf<String>()
        var cursor = today
        while (!cursor.isBefore(today.minusDays(RECENT_DAYS))) {
            dates += cursor.toString(); cursor = cursor.minusDays(1)
        }
        cursor = runCatching { LocalDate.parse(covers).minusDays(1) }.getOrDefault(today)
        while (!cursor.isBefore(floor)) {
            dates += cursor.toString(); cursor = cursor.minusDays(1)
        }
        return dates.toList().asReversed()
    }

    fun clear() {
        index = null
        file.delete()
    }

    private companion object {
        const val BACK_DAYS = 180L
        const val RECENT_DAYS = 12L
        const val CHUNK = 10
        const val TTL_S = 3600L
    }
}
