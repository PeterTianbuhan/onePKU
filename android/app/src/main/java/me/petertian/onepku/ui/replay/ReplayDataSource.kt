package me.petertian.onepku.ui.replay

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import me.petertian.onepku.data.replay.ReplayStore
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * 播放器的数据来源：`onepku-replay://<课次>/index.m3u8` 是本机生成的播放列表，
 * `onepku-replay://<课次>/<n>.ts` 交给 [ReplayStore.part]，本机有就读文件，没有就现取现存。
 */
@UnstableApi
class ReplayDataSource(private val store: ReplayStore) : BaseDataSource(true) {
    private var uri: Uri? = null
    private var input: InputStream? = null
    private var remaining = 0L
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        val key = dataSpec.uri.authority.orEmpty()
        val name = dataSpec.uri.lastPathSegment.orEmpty()
        if (dataSpec.uri.scheme != ReplayStore.SCHEME || key.isEmpty()) throw IOException("不是本机回放地址")
        val total: Long
        val stream: InputStream
        if (name == "index.m3u8") {
            val bytes = store.playlist(key)
            total = bytes.size.toLong()
            stream = ByteArrayInputStream(bytes)
        } else {
            val index = name.removeSuffix(".ts").toIntOrNull() ?: throw IOException("分片地址无效")
            val file = store.part(key, index)
            total = file.length()
            stream = file.inputStream()
        }
        if (dataSpec.position > total) throw IOException("读取位置超出分片")
        stream.skip(dataSpec.position)
        input = stream
        remaining = total - dataSpec.position
        if (dataSpec.length != C.LENGTH_UNSET.toLong()) remaining = minOf(remaining, dataSpec.length)
        opened = true
        transferStarted(dataSpec)
        return remaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val read = input?.read(buffer, offset, minOf(length.toLong(), remaining).toInt()) ?: -1
        if (read < 0) return C.RESULT_END_OF_INPUT
        remaining -= read
        bytesTransferred(read)
        return read
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        uri = null
        try {
            input?.close()
        } finally {
            input = null
            if (opened) {
                opened = false
                transferEnded()
            }
        }
    }

    class Factory(private val store: ReplayStore) : DataSource.Factory {
        override fun createDataSource(): DataSource = ReplayDataSource(store)
    }
}
