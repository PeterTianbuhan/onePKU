package me.petertian.onepku.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import java.io.File

/** 文件持久化的 CookieJar,与桌面版 cookies.json 思路一致。 */
class FileCookieJar(private val file: File) : CookieJar {

    @Serializable
    private data class StoredCookie(
        val name: String,
        val value: String,
        val domain: String,
        val path: String,
        val expiresAt: Long,
        val secure: Boolean,
        val httpOnly: Boolean,
        val hostOnly: Boolean,
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val lock = Any()
    private val cookies = mutableListOf<StoredCookie>()

    init {
        load()
    }

    private fun load() {
        synchronized(lock) {
            if (!file.exists()) return
            runCatching {
                val list = json.decodeFromString(ListSerializer(StoredCookie.serializer()), file.readText())
                cookies.clear()
                cookies.addAll(list)
            }
        }
    }

    private fun persist() {
        runCatching {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(json.encodeToString(ListSerializer(StoredCookie.serializer()), cookies.toList()))
            if (!tmp.renameTo(file)) {
                file.writeText(tmp.readText())
                tmp.delete()
            }
        }
    }

    private fun Cookie.toStored() = StoredCookie(
        name = name,
        value = value,
        domain = domain,
        path = path,
        expiresAt = expiresAt,
        secure = secure,
        httpOnly = httpOnly,
        hostOnly = hostOnly,
    )

    private fun StoredCookie.toCookie(): Cookie {
        val builder = Cookie.Builder()
            .name(name)
            .value(value)
            .path(path)
            .expiresAt(expiresAt)
        if (hostOnly) builder.hostOnlyDomain(domain) else builder.domain(domain.removePrefix("."))
        if (secure) builder.secure()
        if (httpOnly) builder.httpOnly()
        return builder.build()
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val now = System.currentTimeMillis()
        synchronized(lock) {
            cookies.forEach { c ->
                this.cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
                if (c.expiresAt > now) this.cookies.add(c.toStored())
            }
        }
        persist()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        var changed = false
        val matched = synchronized(lock) {
            changed = cookies.removeAll { it.expiresAt <= now }
            cookies.map { it.toCookie() }.filter { it.matches(url) }
        }
        if (changed) persist()
        return matched
    }

    fun clear() {
        synchronized(lock) { cookies.clear() }
        persist()
    }

    fun cookieValue(name: String): String? = synchronized(lock) {
        cookies.lastOrNull { it.name == name }?.value
    }
}
