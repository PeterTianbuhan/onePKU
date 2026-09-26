package me.petertian.onepku.data.curriculum

import android.content.Context
import android.util.LruCache
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

class CurriculumException(message: String) : Exception(message)

/** 读取随应用打包的 data/curriculum 离线数据(构建时由 Gradle 从仓库根同步进 assets)。 */
@Singleton
class CurriculumStore @Inject constructor(@ApplicationContext context: Context) {

    private val assetManager = context.assets
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val cache = LruCache<String, Plan>(16)

    val index: PlanIndex by lazy {
        readAsset("curriculum/index.json")?.let { json.decodeFromString<PlanIndex>(it) }
            ?: throw CurriculumException("培养方案数据缺失")
    }

    suspend fun plan(id: String): Plan = withContext(Dispatchers.IO) {
        cache.get(id) ?: run {
            val entry = index.plans.firstOrNull { it.id == id }
                ?: throw CurriculumException("找不到该培养方案")
            val text = readAsset("curriculum/${entry.file}")
                ?: throw CurriculumException("培养方案文件缺失")
            json.decodeFromString<Plan>(text).also { cache.put(id, it) }
        }
    }

    private fun readAsset(path: String): String? = try {
        assetManager.open(path).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        null
    }

    fun versions(): List<Int> = CurriculumEngine.planVersions(index.plans)

    /** 指定版本下的院系列表。 */
    fun schools(version: Int?): List<String> =
        index.plans.filter { version == null || it.cohort == version }
            .mapNotNull { it.school?.takeIf { s -> s.isNotBlank() } }
            .distinct().sorted()

    fun plansIn(version: Int?, school: String?): List<PlanIndexEntry> = index.plans.filter {
        it.kind != "project" &&
            (version == null || it.cohort == version) &&
            (school == null || it.school == school)
    }

    fun entry(id: String): PlanIndexEntry? = index.plans.firstOrNull { it.id == id }
}
