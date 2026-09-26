package me.petertian.onepku.data.calendar

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.Ua
import okhttp3.Request
import java.io.File
import javax.inject.Inject

class CalendarApiException(message: String) : Exception(message)

/** 校历:学校官方整张 PDF,下载后本地渲染。 */
class CalendarApi @Inject constructor(
    private val httpFactory: HttpFactory,
    @ApplicationContext private val context: Context,
) {

    /** 下载(或取缓存)某学校历 PDF,校验 %PDF- 魔数。 */
    suspend fun pdf(year: SchoolYear): File = withContext(Dispatchers.IO) {
        val dest = File(context.cacheDir, "calendar-${year.key}.pdf")
        if (dest.exists() && dest.length() > 4) return@withContext dest
        val client = httpFactory.client(ua = Ua.NEWS, readTimeoutSec = 60)
        client.newCall(Request.Builder().url(year.url).build()).execute().use { resp ->
            if (!resp.isSuccessful) throw CalendarApiException("校历下载失败: HTTP ${resp.code}")
            val bytes = resp.requireBody().bytes()
            if (bytes.size < 5 || !bytes.copyOf(5).contentEquals("%PDF-".toByteArray(Charsets.US_ASCII))) {
                throw CalendarApiException("校历文件格式异常")
            }
            dest.writeBytes(bytes)
            dest
        }
    }
}

enum class SchoolYear(val key: String, val label: String, val url: String) {
    Y2026("2026-2027", "2026-2027 学年", "https://simso.pku.edu.cn/files/simso/schoolcalendar/2627.pdf"),
    Y2025("2025-2026", "2025-2026 学年", "https://www.pku.edu.cn/Uploads/File/2025/01/17/u6789e9c75f2f9.pdf"),
}
