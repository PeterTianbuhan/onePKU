package me.petertian.onepku.data.card

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlin.math.roundToLong
import me.petertian.onepku.core.network.HttpFactory
import me.petertian.onepku.core.network.requireBody
import me.petertian.onepku.core.network.SessionExpiredException
import me.petertian.onepku.core.network.Ua
import me.petertian.onepku.core.session.Service
import me.petertian.onepku.core.session.SessionStore
import okhttp3.Request
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

data class CardAccount(val name: String, val balanceFen: Long)

data class CardBalance(
    val holder: String,
    val cardNumber: String,
    val electronicFen: Long,
    val accounts: List<CardAccount>,
) {
    /** 校园卡余额以电子账户为准(分),accinfo 仅作信息展示。 */
    val totalFen: Long get() = electronicFen
}

data class TurnoverRecord(
    val summary: String,
    val type: String,
    val amountFen: Long,
    val balanceFen: Long,
    val time: String,
)

data class TurnoverPage(
    val records: List<TurnoverRecord>,
    val total: Long,
    val current: Long,
    val pages: Long,
)

data class MonthlyStat(val expenseFen: Long, val rechargeFen: Long)

class CardApiException(message: String) : Exception(message)

/** 校园卡(新中新 h5 接口):余额、流水、月度收支。金额字段一律为分。 */
class CardApi @Inject constructor(
    private val httpFactory: HttpFactory,
    private val sessionStore: SessionStore,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private fun jwt(): String {
        val session = sessionStore.session(Service.CARD) ?: throw SessionExpiredException("校园卡未登录")
        if (session.isExpired()) throw SessionExpiredException()
        return session.token
    }

    private suspend fun apiGet(path: String): JsonObject = withContext(Dispatchers.IO) {
        val client = httpFactory.client(
            ua = Ua.MOBILE_CARD,
            headers = mapOf(
                "x-requested-with" to "cn.edu.pku.PKUAndroid",
                "synjones-auth" to "bearer ${jwt()}",
                "synaccesssource" to "h5",
            ),
            http1Only = true,
        )
        val sep = if (path.contains("?")) "&" else "?"
        val url = "$CARD_BASE$path${sep}synAccessSource=h5"
        client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
            val body = resp.requireBody().string()
            if (resp.code == 401) throw SessionExpiredException()
            val obj = runCatching { json.parseToJsonElement(body).jsonObject }
                .getOrElse { throw CardApiException("响应无法解析: HTTP ${resp.code}") }
            if (obj["code"]?.jsonPrimitive?.longOrNull == 401L) throw SessionExpiredException()
            obj
        }
    }

    suspend fun balance(): CardBalance {
        val obj = apiGet("/berserker-app/ykt/tsm/queryCard")
        val card = obj["data"]?.jsonObject?.get("card")?.jsonArray?.firstOrNull()?.jsonObject
            ?: throw CardApiException("未查询到校园卡")
        fun s(o: JsonObject, k: String) = o[k]?.jsonPrimitive?.content.orEmpty()
        val accounts = card["accinfo"]?.jsonArray.orEmpty().mapNotNull { el ->
            val a = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            CardAccount(
                name = s(a, "name"),
                balanceFen = a["balance"]?.jsonPrimitive?.longOrNull ?: 0,
            )
        }
        return CardBalance(
            holder = s(card, "name"),
            cardNumber = s(card, "account"),
            electronicFen = card["elec_accamt"]?.jsonPrimitive?.longOrNull ?: 0,
            accounts = accounts,
        )
    }

    suspend fun turnover(page: Int, size: Int = 20, timeFrom: String = "", timeTo: String = ""): TurnoverPage {
        val obj = apiGet(
            "/berserker-search/search/personal/turnover?size=$size&current=$page&timeFrom=$timeFrom&timeTo=$timeTo"
        )
        val data = obj["data"]?.jsonObject ?: return TurnoverPage(emptyList(), 0, 1, 0)
        val records = data["records"]?.jsonArray.orEmpty().mapNotNull { el ->
            val r = runCatching { el.jsonObject }.getOrNull() ?: return@mapNotNull null
            TurnoverRecord(
                summary = r["resume"]?.jsonPrimitive?.content.orEmpty(),
                type = r["turnoverType"]?.jsonPrimitive?.content.orEmpty(),
                amountFen = r["tranamt"]?.jsonPrimitive?.longOrNull ?: 0,
                balanceFen = r["cardBalance"]?.jsonPrimitive?.longOrNull ?: 0,
                time = r["effectdateStr"]?.jsonPrimitive?.content.orEmpty(),
            )
        }
        return TurnoverPage(
            records = records,
            total = data["total"]?.jsonPrimitive?.longOrNull ?: 0,
            current = data["current"]?.jsonPrimitive?.longOrNull ?: page.toLong(),
            pages = data["pages"]?.jsonPrimitive?.longOrNull ?: 1,
        )
    }

    /**
     * 本月统计。支出用分类统计接口 type=2(消费)求和,排除充值/转账等非消费转出;
     * 充值用 turnover/count 的 income。两个接口的金额单位都是分。
     */
    suspend fun monthlyStat(): MonthlyStat {
        val now = Date()
        val zone = java.util.TimeZone.getTimeZone("Asia/Shanghai")
        val from = SimpleDateFormat("yyyy-MM-01", Locale.US).apply { timeZone = zone }.format(now)
        val to = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = zone }.format(now)

        val categories = apiGet("/berserker-search/statistics/turnover?type=2&timeFrom=$from&timeTo=$to")
        val rows = categories["data"]?.jsonArray.orEmpty().mapNotNull { el ->
            runCatching { el.jsonObject }.getOrNull()
        }
        val expenseFen = rows.sumOf { it["amount"]?.jsonPrimitive?.doubleOrNull ?: 0.0 }.roundToLong()

        val count = apiGet("/berserker-search/statistics/turnover/count?timeFrom=$from&timeTo=$to")
        val rechargeFen = count["data"]?.jsonObject?.get("income")
            ?.jsonPrimitive?.doubleOrNull?.roundToLong() ?: 0L

        return MonthlyStat(expenseFen = expenseFen, rechargeFen = rechargeFen)
    }

    companion object {
        const val CARD_BASE = "https://bdcard.pku.edu.cn"
    }
}

/** 分 → "12.34" 元字符串。 */
fun fenToYuan(fen: Long): String = "%.2f".format(Locale.US, fen / 100.0)
