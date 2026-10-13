package me.petertian.onepku.core.network

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CookieStores @Inject constructor(@ApplicationContext context: Context) {
    private val dir = File(context.filesDir, "cookies")
    private val jars = ConcurrentHashMap<String, FileCookieJar>()

    fun jar(service: String): FileCookieJar = jars.getOrPut(service) {
        FileCookieJar(File(dir, "$service.json"))
    }

    fun clear(service: String) {
        jars[service]?.clear()
    }

    fun clearAll() {
        jars.values.forEach { it.clear() }
    }
}
