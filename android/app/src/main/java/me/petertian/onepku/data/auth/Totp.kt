package me.petertian.onepku.data.auth

import java.net.URI
import java.net.URLDecoder
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * IAAA 手机令牌。与 `vendor/pkucli` 的 `otp.rs` 同一套：RFC 6238，HMAC-SHA1，6 位，30 秒。
 * 这里只算口令，不写日志，调用方也不要把密钥或口令放进异常信息。
 */
object Totp {
    const val PERIOD_SEC = 30L
    private const val DIGITS = 6
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun current(secretBase32: String, nowMs: Long = System.currentTimeMillis()): String =
        generate(secretBase32, nowMs / 1000)

    fun generate(secretBase32: String, unixSecs: Long): String {
        val key = decodeBase32(secretBase32)
        val counter = unixSecs / PERIOD_SEC
        val mac = Mac.getInstance("HmacSHA1")
        mac.init(SecretKeySpec(key, "HmacSHA1"))
        val hash = mac.doFinal(ByteArray(8).also { bytes ->
            var value = counter
            for (i in 7 downTo 0) {
                bytes[i] = (value and 0xff).toByte()
                value = value ushr 8
            }
        })
        val offset = hash.last().toInt() and 0x0f
        val binary = ((hash[offset].toInt() and 0x7f) shl 24) or
            ((hash[offset + 1].toInt() and 0xff) shl 16) or
            ((hash[offset + 2].toInt() and 0xff) shl 8) or
            (hash[offset + 3].toInt() and 0xff)
        return (binary % 1_000_000).toString().padStart(DIGITS, '0')
    }

    /**
     * 接受 otpauth:// 链接或 Base32 密钥。成功时返回去掉空白和填充的大写密钥。
     * 算法、位数、周期与上面不一致时返回 null，避免算出一个对不上的口令。
     */
    fun parseSecret(input: String): String? {
        val raw = input.trim()
        if (raw.isEmpty()) return null
        val secret = if (raw.startsWith("otpauth://", ignoreCase = true)) {
            secretFromUri(raw) ?: return null
        } else {
            raw
        }
        return runCatching { normalize(secret) }.getOrNull()
    }

    private fun secretFromUri(raw: String): String? {
        val uri = runCatching { URI(raw) }.getOrNull() ?: return null
        if (!uri.scheme.equals("otpauth", ignoreCase = true)) return null
        if (!uri.host.equals("totp", ignoreCase = true)) return null
        val params = query(uri.rawQuery ?: return null)
        val algorithm = params["algorithm"]
        if (algorithm != null && !algorithm.equals("SHA1", ignoreCase = true)) return null
        val digits = params["digits"]
        if (digits != null && digits != "6") return null
        val period = params["period"]
        if (period != null && period != "30") return null
        return params["secret"]
    }

    private fun query(raw: String): Map<String, String> = raw.split("&").mapNotNull { part ->
        val i = part.indexOf('=')
        if (i <= 0) return@mapNotNull null
        val key = decode(part.substring(0, i)).lowercase()
        val value = decode(part.substring(i + 1))
        key to value
    }.toMap()

    private fun decode(value: String): String =
        runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)

    private fun normalize(secret: String): String {
        val compact = buildString(secret.length) {
            for (c in secret) {
                if (c.isWhitespace() || c == '-' || c == '=') continue
                append(c.uppercaseChar())
            }
        }
        if (compact.isEmpty()) throw IllegalArgumentException("empty totp secret")
        decodeBase32(compact)
        return compact
    }

    private fun decodeBase32(secret: String): ByteArray {
        var buffer = 0
        var bits = 0
        val out = ArrayList<Byte>(secret.length * 5 / 8)
        for (c in secret) {
            if (c.isWhitespace() || c == '-' || c == '=') continue
            val value = ALPHABET.indexOf(c.uppercaseChar())
            if (value < 0) throw IllegalArgumentException("bad base32")
            buffer = (buffer shl 5) or value
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out.add(((buffer shr bits) and 0xff).toByte())
            }
        }
        if (out.isEmpty()) throw IllegalArgumentException("empty totp secret")
        return out.toByteArray()
    }
}
