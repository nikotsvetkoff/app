package com.example.iptv

import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer

class PlayerController(private val exoPlayer: ExoPlayer) {
    fun play(url: String, startAtSec: Double = 0.0) {
        val item = MediaItem.fromUri(url)
        exoPlayer.setMediaItem(item)
        exoPlayer.prepare()
        if (startAtSec > 0.0) {
            exoPlayer.seekTo((startAtSec * 1000).toLong())
        }
        exoPlayer.playWhenReady = true
    }

    fun pause() {
        exoPlayer.pause()
    }

    fun stop() {
        exoPlayer.stop()
    }

    fun release() {
        exoPlayer.release()
    }
}