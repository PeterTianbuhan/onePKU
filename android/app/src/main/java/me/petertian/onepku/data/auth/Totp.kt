package me.petertian.onepku.data.auth

import java.nio.ByteBuffer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * IAAA 手机令牌：RFC 6238，HMAC-SHA1，6 位，30 秒。
 */
object Totp {
    private const val PERIOD = 30L
    private const val DIGITS = 6
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun generate(secretBase32: String, nowSeconds: Long = System.currentTimeMillis() / 1000): String {
        val secret = decodeBase32(secretBase32)
        val counter = nowSeconds / PERIOD
        val mac = Mac.getInstance("HmacSHA1")
        mac.init(SecretKeySpec(secret, "HmacSHA1"))
        val hash = mac.doFinal(ByteBuffer.allocate(8).putLong(counter).array())
        val offset = hash.last().toInt() and 0x0f
        val binary = ((hash[offset].toInt() and 0x7f) shl 24) or
            ((hash[offset + 1].toInt() and 0xff) shl 16) or
            ((hash[offset + 2].toInt() and 0xff) shl 8) or
            (hash[offset + 3].toInt() and 0xff)
        val code = binary % Math.pow(10.0, DIGITS.toDouble()).toInt()
        return code.toString().padStart(DIGITS, '0')
    }

    fun decodeBase32(secret: String): ByteArray {
        val compact = secret.uppercase().filter { it != ' ' && it != '=' }
        if (compact.isEmpty() || compact.any { it !in ALPHABET }) {
            throw IllegalArgumentException("手机令牌密钥无法使用，请检查是不是 Base32 密钥")
        }
        val out = ArrayList<Byte>(compact.length * 5 / 8)
        var buffer = 0
        var bits = 0
        for (char in compact) {
            buffer = (buffer shl 5) or ALPHABET.indexOf(char)
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out += ((buffer shr bits) and 0xff).toByte()
            }
        }
        if (out.isEmpty()) throw IllegalArgumentException("手机令牌密钥是空的")
        return out.toByteArray()
    }
}
