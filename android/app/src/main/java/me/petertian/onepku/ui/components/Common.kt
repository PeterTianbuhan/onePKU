package me.petertian.onepku.ui.components

import android.content.Context
import android.content.Intent
import android.text.method.LinkMovementMethod
import android.widget.TextView
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.core.text.HtmlCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import me.petertian.onepku.BuildConfig

/** 页面级异步数据状态。 */
sealed interface UiData<out T> {
    data object Loading : UiData<Nothing>
    data class Ready<T>(val value: T) : UiData<T>
    data class Failure(val message: String) : UiData<Nothing>

    fun orNull(): T? = (this as? Ready<T>)?.value
}

@Composable
fun LoadingBox(modifier: Modifier = Modifier, message: String = "加载中…") {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(Modifier.size(36.dp))
            Spacer(Modifier.height(12.dp))
            Text(message, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun ErrorBox(message: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null) {
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
            )
            if (onRetry != null) {
                Spacer(Modifier.height(12.dp))
                Button(onClick = onRetry) { Text("重试") }
            }
        }
    }
}

@Composable
fun EmptyBox(message: String, modifier: Modifier = Modifier.fillMaxSize()) {
    Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

/** 简单 HTML 渲染(公告、通知正文);不加载图片与脚本。 */
@Composable
fun HtmlText(html: String, modifier: Modifier = Modifier, textSizeSp: Float = 15f) {
    val color = MaterialTheme.colorScheme.onSurface
    AndroidView(
        factory = { ctx ->
            TextView(ctx).apply {
                movementMethod = LinkMovementMethod.getInstance()
                setTextColor(color.toArgb())
                textSize = textSizeSp
                setLineSpacing(0f, 1.25f)
            }
        },
        update = { view ->
            view.text = HtmlCompat.fromHtml(html, HtmlCompat.FROM_HTML_MODE_LEGACY)
        },
        modifier = modifier,
    )
}

/** 通用的块状错误/加载占位,用于页面内独立刷新的区块。 */
@Composable
fun <T> SectionContent(
    data: UiData<T>,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
    emptyMessage: String = "暂无内容",
    isEmpty: (T) -> Boolean = { false },
    content: @Composable (T) -> Unit,
) {
    when (data) {
        is UiData.Loading -> Column(
            modifier.padding(24.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) { CircularProgressIndicator(Modifier.size(28.dp)) }
        is UiData.Failure -> Column(
            modifier.padding(24.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(data.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
            if (onRetry != null) {
                Spacer(Modifier.height(8.dp))
                Button(onClick = onRetry) { Text("重试") }
            }
        }
        is UiData.Ready -> if (isEmpty(data.value)) {
            Column(
                modifier.padding(24.dp).fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(emptyMessage, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
        } else {
            content(data.value)
        }
    }
}

/** 区块小标题,各页面共用。 */
@Composable
fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
}

private val TERM_KEY = Regex("^(\\d{2,4})-(\\d{2,4})-(\\d)$")
private val TERM_DOT = Regex("^(\\d{2,4})-(\\d{2,4})·(\\d)$")
private val TERM_CN = Regex("^(\\d{2,4})-(\\d{2,4})\\s*学年第\\s*(\\d)\\s*学期$")

private fun fullYear(value: String) = if (value.length == 2) "20$value" else value

/** 各来源的学期写法不一,统一显示为"2024-2025 学年秋季学期";认不出的原样返回。 */
fun formatTerm(raw: String?): String {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty()) return ""
    for (pattern in listOf(TERM_KEY, TERM_DOT, TERM_CN)) {
        val (from, to, term) = (pattern.matchEntire(text) ?: continue).destructured
        val season = when (term) { "1" -> "秋"; "2" -> "春"; "3" -> "夏"; else -> term }
        return "${fullYear(from)}-${fullYear(to)} 学年${season}季学期"
    }
    return text
}

/** 用系统里能处理该类型的应用打开文件;没有这样的应用时退一步告知文件位置。 */
fun openFile(context: Context, file: File) {
    runCatching {
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, context.contentResolver.getType(uri) ?: "*/*")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(Intent.createChooser(intent, file.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.onFailure {
        Toast.makeText(context, "本机没有能打开 ${file.name} 的应用;文件在 ${file.absolutePath}", Toast.LENGTH_LONG).show()
    }
}

/** 学校给出的时刻一律按北京时间显示,与设备所在时区无关。 */
fun formatDateTime(epochMs: Long): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("Asia/Shanghai")
    }.format(Date(epochMs))
