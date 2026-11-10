package me.petertian.onepku.data.replay

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

/** 一节课的播放进度。身份是原始 course_id + episode_id。线上字段用下划线。 */
@Serializable
data class ProgressRecord(
    @SerialName("course_id") val courseId: String,
    @SerialName("episode_id") val episodeId: String,
    @SerialName("position_seconds") val positionSeconds: Double,
    val completed: Boolean,
    @SerialName("updated_at") val updatedAt: String,
    @SerialName("device_id") val deviceId: String = "",
)

fun progressInstant(value: String): Instant =
    runCatching { Instant.parse(value) }.getOrDefault(Instant.EPOCH)

/**
 * 位置按 updatedAt 后写为准；completed 一旦为真就保持。时间相同则采用 incoming。
 * 解析不了的时间当成最早，避免脏数据盖住另一台设备。
 */
fun mergeProgress(current: ProgressRecord?, incoming: ProgressRecord?): ProgressRecord? {
    if (current == null) return incoming
    if (incoming == null) return current
    val winner = if (!progressInstant(incoming.updatedAt).isBefore(progressInstant(current.updatedAt))) incoming else current
    return winner.copy(completed = current.completed || incoming.completed)
}

/** 能连上边车时返回去掉末尾斜杠的基地址，否则返回 null，同步保持关闭。 */
fun progressBase(url: String, token: String): String? {
    val secret = token.trim()
    if (secret.length < 24 || secret.any { it.isWhitespace() }) return null
    val base = url.trim().trimEnd('/')
    if (base.isEmpty() || base.any { it.isWhitespace() } || '?' in base || '#' in base) return null
    val afterScheme = base.substringAfter("://", "")
    if (afterScheme.isEmpty() || '@' in afterScheme.substringBefore('/')) return null
    val https = base.startsWith("https://") && afterScheme.substringBefore('/').isNotEmpty()
    val local = Regex("^http://(127\\.0\\.0\\.1|localhost)(:[0-9]+)?(/.*)?$").matches(base)
    if (!https && !local) return null
    return base
}
