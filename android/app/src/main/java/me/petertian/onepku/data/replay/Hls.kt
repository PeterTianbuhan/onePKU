package me.petertian.onepku.data.replay

import okhttp3.HttpUrl.Companion.toHttpUrl
import java.math.BigInteger
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 回放的 HLS 媒体播放列表：只认整段 TS 分片，可选 AES-128 整段加密，与桌面端同一口径。 */
object Hls {
    class Segment(val url: String, val duration: Double, val discontinuity: Boolean, val keyUrl: String?, val iv: ByteArray?)

    class Playlist(val segments: List<Segment>) {
        /**
         * 判断「还是不是同一份录像」：分片路径（不含会过期的查询串）、时长与断点。
         * 签名地址换了而录像没变时，已下载的分片可以接着用。
         */
        val signature: String by lazy {
            val rows = segments.joinToString("\n") {
                "${it.url.toHttpUrl().encodedPath}|${it.duration}|${it.discontinuity}"
            }
            MessageDigest.getInstance("SHA-256").digest(rows.toByteArray()).joinToString("") { "%02x".format(it) }
        }
    }

    class FormatException(message: String) : Exception(message)

    fun parse(text: String, base: String): Playlist {
        val lines = text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
        if (lines.firstOrNull() != "#EXTM3U") throw FormatException("学校返回的不是播放列表")
        if (lines.any { it.startsWith("#EXT-X-STREAM-INF") }) throw FormatException("暂不支持多码率播放列表")
        val baseUrl = base.toHttpUrl()
        var sequence = 0L
        var duration: Double? = null
        var discontinuity = false
        var keyUrl: String? = null
        var keyIv: ByteArray? = null
        var ended = false
        val segments = mutableListOf<Segment>()
        for (line in lines) {
            when {
                line.startsWith("#EXT-X-MEDIA-SEQUENCE:") -> sequence = line.substringAfter(':').toLongOrNull() ?: 0
                line.startsWith("#EXTINF:") -> duration = line.substringAfter(':').substringBefore(',').toDoubleOrNull()
                line == "#EXT-X-DISCONTINUITY" -> discontinuity = true
                line == "#EXT-X-ENDLIST" -> ended = true
                line.startsWith("#EXT-X-BYTERANGE") || line.startsWith("#EXT-X-MAP") ->
                    throw FormatException("这节回放的分段格式暂不支持")
                line.startsWith("#EXT-X-KEY:") -> {
                    val attrs = attributes(line.substringAfter(':'))
                    when (attrs["METHOD"]) {
                        "NONE" -> { keyUrl = null; keyIv = null }
                        "AES-128" -> {
                            val uri = attrs["URI"] ?: throw FormatException("视频密钥地址缺失")
                            keyUrl = baseUrl.resolve(uri)?.toString() ?: throw FormatException("视频密钥地址无效")
                            keyIv = attrs["IV"]?.let(::hexIv)
                        }
                        else -> throw FormatException("这节回放的加密格式暂不支持")
                    }
                }
                line.startsWith("#") -> Unit
                else -> {
                    val length = duration?.takeIf { it.isFinite() && it > 0 } ?: throw FormatException("分片时长无效")
                    val url = baseUrl.resolve(line)?.toString() ?: throw FormatException("分片地址无效")
                    val iv = if (keyUrl == null) null else keyIv ?: sequenceIv(sequence + segments.size)
                    segments += Segment(url, length, discontinuity, keyUrl, iv)
                    duration = null
                    discontinuity = false
                }
            }
        }
        if (!ended || segments.isEmpty() || segments.size > 10_000) throw FormatException("回放还没有生成完整视频")
        return Playlist(segments)
    }

    private fun attributes(text: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        Regex("""([A-Z0-9-]+)=("[^"]*"|[^,]*)""").findAll(text).forEach {
            out[it.groupValues[1]] = it.groupValues[2].removeSurrounding("\"")
        }
        return out
    }

    private fun hexIv(text: String): ByteArray {
        val hex = text.removePrefix("0x").removePrefix("0X")
        return toBlock(BigInteger(hex, 16))
    }

    /** 没写 IV 时按 HLS 规范用分片序号。 */
    fun sequenceIv(number: Long): ByteArray = toBlock(BigInteger.valueOf(number))

    private fun toBlock(value: BigInteger): ByteArray {
        val raw = value.toByteArray().takeLast(16).toByteArray()
        return ByteArray(16 - raw.size) + raw
    }

    fun decrypt(key: ByteArray, iv: ByteArray, data: ByteArray): ByteArray =
        Cipher.getInstance("AES/CBC/PKCS5Padding").run {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            doFinal(data)
        }

    /** 完整的 MPEG-TS：188 字节一包、每包 0x47 开头。HTML 错误页或截断的分片不能写进缓存。 */
    fun isTransportStream(bytes: ByteArray): Boolean =
        bytes.size >= 188 && bytes.size % 188 == 0 && (bytes.indices step 188).all { bytes[it] == 0x47.toByte() }

    /** 给播放器的本地播放列表。分片地址是本机的 `onepku-replay://`，不含任何学校地址或令牌。 */
    fun localPlaylist(key: String, durations: List<Double>, discontinuities: Set<Int>): String = buildString {
        append("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n")
        append("#EXT-X-TARGETDURATION:${(durations.maxOrNull() ?: 10.0).let { Math.ceil(it).toInt() }}\n")
        append("#EXT-X-MEDIA-SEQUENCE:0\n")
        durations.forEachIndexed { index, duration ->
            if (index in discontinuities) append("#EXT-X-DISCONTINUITY\n")
            append("#EXTINF:${"%.3f".format(java.util.Locale.US, duration)},\n")
            append("${ReplayStore.SCHEME}://$key/$index.ts\n")
        }
        append("#EXT-X-ENDLIST\n")
    }
}
