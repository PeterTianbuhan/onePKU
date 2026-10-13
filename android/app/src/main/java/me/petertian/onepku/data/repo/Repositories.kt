package me.petertian.onepku.data.repo

import me.petertian.onepku.core.session.Service
import me.petertian.onepku.data.auth.AuthManager
import me.petertian.onepku.data.card.CardApi
import me.petertian.onepku.data.card.CardBalance
import me.petertian.onepku.data.card.MonthlyStat
import me.petertian.onepku.data.card.TurnoverPage
import me.petertian.onepku.data.treehole.ScoreReport
import me.petertian.onepku.data.treehole.TreeholeApi
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TreeholeRepository @Inject constructor(
    private val api: TreeholeApi,
    private val auth: AuthManager,
) {
    private var scoresCache: CacheEntry<ScoreReport>? = null

    suspend fun scores(forceRefresh: Boolean = false): ScoreReport {
        scoresCache?.takeIf { !forceRefresh && it.fresh(TTL) }?.let { return it.data }
        return withReauth(auth, Service.TREEHOLE) { api.scores() }.also { scoresCache = CacheEntry(it) }
    }

    suspend fun sendSms(): String = api.sendSmsCode()

    suspend fun verifySms(code: String) {
        api.verifySmsCode(code)
        scoresCache = null
    }

    companion object {
        private const val TTL = 10 * 60 * 1000L
    }
}

@Singleton
class CardRepository @Inject constructor(
    private val api: CardApi,
    private val auth: AuthManager,
) {
    private var balanceCache: CacheEntry<CardBalance>? = null

    suspend fun balance(forceRefresh: Boolean = false): CardBalance {
        balanceCache?.takeIf { !forceRefresh && it.fresh(TTL) }?.let { return it.data }
        return withReauth(auth, Service.CARD) { api.balance() }.also { balanceCache = CacheEntry(it) }
    }

    suspend fun turnover(page: Int): TurnoverPage = withReauth(auth, Service.CARD) { api.turnover(page) }

    suspend fun monthly(): MonthlyStat = withReauth(auth, Service.CARD) { api.monthlyStat() }

    companion object {
        private const val TTL = 5 * 60 * 1000L
    }
}
