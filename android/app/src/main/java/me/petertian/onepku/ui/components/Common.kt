package me.petertian.onepku.ui.components

import android.text.method.LinkMovementMethod
import android.widget.TextView
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.text.HtmlCompat

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
fun EmptyBox(message: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
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
