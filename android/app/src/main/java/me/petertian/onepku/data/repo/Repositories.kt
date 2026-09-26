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
    private val scoresCache = ScopedCache<Unit, ScoreReport>({ auth.cacheScope(Service.TREEHOLE) }, TTL)

    suspend fun scores(forceRefresh: Boolean = false): ScoreReport =
        scoresCache.get(Unit, forceRefresh) { withReauth(auth, Service.TREEHOLE) { api.scores() } }

    suspend fun sendSms(): String = api.sendSmsCode()

    suspend fun verifySms(code: String) {
        api.verifySmsCode(code)
        scores(true)
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
    private val balanceCache = ScopedCache<Unit, CardBalance>({ auth.cacheScope(Service.CARD) }, TTL)

    suspend fun balance(forceRefresh: Boolean = false): CardBalance =
        balanceCache.get(Unit, forceRefresh) { withReauth(auth, Service.CARD) { api.balance() } }

    suspend fun turnover(page: Int): TurnoverPage = withReauth(auth, Service.CARD) { api.turnover(page) }

    suspend fun monthly(): MonthlyStat = withReauth(auth, Service.CARD) { api.monthlyStat() }

    companion object {
        private const val TTL = 5 * 60 * 1000L
    }
}
