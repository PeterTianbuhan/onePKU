package me.petertian.onepku

import android.app.Application
import dagger.hilt.android.HiltAndroidApp
import me.petertian.onepku.data.auth.AuthManager
import javax.inject.Inject

@HiltAndroidApp
class OnePkuApp : Application() {
    @Inject lateinit var auth: AuthManager

    override fun onCreate() {
        super.onCreate()
        auth.renewStaleSessions()
    }
}
