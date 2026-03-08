package com.example.iptv

import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent as AndroidKeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.net.URI

private enum class ScreenView {
    MENU,
    PAIRING,
    TOKEN,
    PLAYER
}

private const val LIST_VISIBLE_COUNT = 10
private const val GUIDE_TIMELINE_STEP_MS = 30 * 60 * 1000L

private data class PlaybackOverride(
    val channelId: String,
    val url: String,
    val label: String
)

private fun normalizeDeviceFingerprint(value: String?): String? {
    if (value.isNullOrBlank()) {
        return null
    }
    val normalized = value
        .trim()
        .uppercase()
        .replace(Regex("[^0-9A-Z]"), "")
    return normalized.takeIf { it.length >= 6 }
}

private fun buildPairingDeviceName(baseName: String, fingerprint: String?): String {
    val normalizedBase = baseName.trim().replace(Regex("\\s+"), " ").ifBlank { "Android device" }
    if (fingerprint.isNullOrBlank()) {
        return normalizedBase.take(64)
    }

    val suffix = " [$fingerprint]"
    val allowedBaseLength = (64 - suffix.length).coerceAtLeast(0)
    return "${normalizedBase.take(allowedBaseLength)}$suffix"
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    IptvScreen()
                }
            }
        }
    }

    @Composable
    private fun IptvScreen() {
        val scope = rememberCoroutineScope()
        val store = remember { DeviceStore(this) }
        val clipboard = LocalClipboardManager.current
        val initialApiBase = remember { store.getApiBaseUrl() ?: BuildConfig.API_BASE_URL }
        var apiBase by rememberSaveable { mutableStateOf(initialApiBase) }
        var apiBaseInput by rememberSaveable { mutableStateOf(initialApiBase) }
        val backend = remember(apiBase) { BackendClient(this, apiBase) }
        val exoPlayer = remember { ExoPlayer.Builder(this).build() }
        val playerController = remember { PlayerController(exoPlayer) }

        val isTv = remember {
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
                packageManager.hasSystemFeature(PackageManager.FEATURE_TELEVISION)
        }
        val deviceName = if (isTv) "Android TV" else "Android device"
        val devicePlatform = if (isTv) "android-tv" else "android"
        val deviceFingerprint = remember {
            normalizeDeviceFingerprint(
                runCatching {
                    Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                }.getOrNull()
            )
        }
        val pairingDeviceName = remember(deviceName, deviceFingerprint) {
            buildPairingDeviceName(deviceName, deviceFingerprint)
        }

        var view by rememberSaveable { mutableStateOf(ScreenView.MENU) }
        var menuIndex by rememberSaveable { mutableIntStateOf(0) }
        var tokenIndex by rememberSaveable { mutableIntStateOf(0) }
        var showList by rememberSaveable { mutableStateOf(true) }

        var status by rememberSaveable { mutableStateOf<String?>(null) }
        var error by rememberSaveable { mutableStateOf<String?>(null) }
        var pairCode by rememberSaveable { mutableStateOf<String?>(null) }
        var tokenInput by rememberSaveable { mutableStateOf("test") }

        var channels by remember { mutableStateOf<List<Channel>>(emptyList()) }
        var nowNextMap by remember { mutableStateOf<Map<String, NowNextItem>>(emptyMap()) }
        var epgDayByTvgId by remember { mutableStateOf<Map<String, List<ProgramInfo>>>(emptyMap()) }
        var favorites by remember { mutableStateOf(store.getFavorites()) }
        var selectedCategoryIndex by rememberSaveable { mutableIntStateOf(0) }
        var selectedIndex by rememberSaveable { mutableIntStateOf(0) }
        var playingChannelId by rememberSaveable { mutableStateOf<String?>(null) }
        var guideFocusTimeMs by rememberSaveable { mutableLongStateOf(System.currentTimeMillis()) }
        var playbackOverride by remember { mutableStateOf<PlaybackOverride?>(null) }
        var pairingJob by remember { mutableStateOf<Job?>(null) }

        val categories = remember(channels) {
            val grouped = linkedMapOf<String, MutableList<Channel>>()
            for (channel in channels) {
                val key = normalizeGroupName(channel.groupName ?: channel.group)
                grouped.getOrPut(key) { mutableListOf() }.add(channel)
            }
            grouped.toList()
        }
        val categoryChannels = categories.getOrNull(selectedCategoryIndex)?.second.orEmpty()
        val selectedChannel = categoryChannels.getOrNull(selectedIndex)
        val playingChannel = remember(channels, playingChannelId, selectedChannel) {
            val channelById = playingChannelId?.let { currentId ->
                channels.firstOrNull { it.id == currentId }
            }
            channelById ?: selectedChannel
        }
        val nowNext = playingChannel?.id?.let { nowNextMap[it] }
        val visibleStart = remember(selectedIndex, categoryChannels.size) {
            kotlin.math.max(0, selectedIndex - (LIST_VISIBLE_COUNT - 1))
        }
        val visibleEnd = remember(selectedIndex, categoryChannels.size) {
            kotlin.math.min(categoryChannels.size, visibleStart + LIST_VISIBLE_COUNT)
        }
        val visibleChannels = remember(categoryChannels, visibleStart, visibleEnd) {
            if (categoryChannels.isEmpty()) {
                emptyList()
            } else {
                categoryChannels.subList(visibleStart, visibleEnd)
            }
        }
        val pairingUrl = buildWebAdminPairUrl(apiBase, pairCode)

        fun normalizeTvgId(value: String?): String = value?.trim()?.lowercase().orEmpty()

        fun parseProgramTimestamp(value: String?): Long? {
            if (value.isNullOrBlank()) {
                return null
            }
            return runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        }

        fun formatTime(value: String?): String {
            val timestamp = parseProgramTimestamp(value) ?: return "--:--"
            val localDateTime = Instant.ofEpochMilli(timestamp).atZone(ZoneId.systemDefault()).toLocalDateTime()
            return String.format("%02d:%02d", localDateTime.hour, localDateTime.minute)
        }

        fun formatTimeFromTimestamp(timestampMs: Long): String {
            val localDateTime = Instant.ofEpochMilli(timestampMs).atZone(ZoneId.systemDefault()).toLocalDateTime()
            return String.format("%02d:%02d", localDateTime.hour, localDateTime.minute)
        }

        fun formatProgramRange(program: ProgramInfo?): String {
            if (program == null) {
                return "--:-- - --:--"
            }
            return "${formatTime(program.start)} - ${formatTime(program.end)}"
        }

        fun getProgramsForChannel(channel: Channel?): List<ProgramInfo> {
            if (channel == null) {
                return emptyList()
            }

            val tvgId = normalizeTvgId(channel.tvgId)
            val fromDayGrid = if (tvgId.isBlank()) null else epgDayByTvgId[tvgId]
            if (!fromDayGrid.isNullOrEmpty()) {
                return fromDayGrid
            }

            val nowNextItem = nowNextMap[channel.id]
            return listOfNotNull(nowNextItem?.now, nowNextItem?.next).sortedBy {
                parseProgramTimestamp(it.start) ?: Long.MAX_VALUE
            }
        }

        fun findGuideProgramAtTime(programs: List<ProgramInfo>, timestampMs: Long): ProgramInfo? {
            val active = programs.firstOrNull { program ->
                val start = parseProgramTimestamp(program.start)
                val end = parseProgramTimestamp(program.end)
                start != null && end != null && timestampMs in start until end
            }
            if (active != null) {
                return active
            }

            val next = programs.firstOrNull { program ->
                val start = parseProgramTimestamp(program.start)
                start != null && start >= timestampMs
            }
            return next ?: programs.lastOrNull()
        }

        fun getGuideProgramForChannel(channel: Channel?): ProgramInfo? {
            val programs = getProgramsForChannel(channel)
            return findGuideProgramAtTime(programs, guideFocusTimeMs)
        }

        fun resolveArchiveDays(channel: Channel?): Int {
            if (channel == null) {
                return 0
            }
            val explicit = channel.catchupDays
            if (explicit != null && explicit > 0) {
                return explicit
            }
            return if (!channel.catchupSource.isNullOrBlank() || !channel.catchup.isNullOrBlank()) 14 else 0
        }

        fun toEpochSeconds(timestampMs: Long): String = (timestampMs / 1000L).toString()

        fun buildArchiveUrl(channel: Channel, program: ProgramInfo): String? {
            val rawStartMs = parseProgramTimestamp(program.start) ?: return null
            val rawEndMs = parseProgramTimestamp(program.end) ?: return null
            if (rawEndMs <= rawStartMs) {
                return null
            }

            val correctionMs = ((channel.catchupCorrection ?: 0.0) * 60 * 60 * 1000).toLong()
            val startMs = rawStartMs + correctionMs
            val endMs = rawEndMs + correctionMs
            val durationSeconds = ((rawEndMs - rawStartMs) / 1000L).coerceAtLeast(60L)
            val startEpoch = toEpochSeconds(startMs)
            val endEpoch = toEpochSeconds(endMs)
            val startIso = Instant.ofEpochMilli(startMs).toString()
            val endIso = Instant.ofEpochMilli(endMs).toString()
            val replacements = listOf(
                "{start}" to startEpoch,
                "\${start}" to startEpoch,
                "{end}" to endEpoch,
                "\${end}" to endEpoch,
                "{duration}" to durationSeconds.toString(),
                "\${duration}" to durationSeconds.toString(),
                "{utc}" to startEpoch,
                "\${utc}" to startEpoch,
                "{lutc}" to startEpoch,
                "\${lutc}" to startEpoch,
                "{start_iso}" to startIso,
                "\${start_iso}" to startIso,
                "{end_iso}" to endIso,
                "\${end_iso}" to endIso
            )

            val template = channel.catchupSource?.trim().orEmpty()
            if (template.isNotBlank()) {
                var resolved = template
                for ((token, replacement) in replacements) {
                    resolved = resolved.replace(token, replacement)
                }
                return try {
                    URI(channel.url).resolve(resolved).toString()
                } catch (_: Throwable) {
                    resolved
                }
            }

            return try {
                Uri.parse(channel.url)
                    .buildUpon()
                    .appendQueryParameter("utc", startEpoch)
                    .appendQueryParameter("lutc", startEpoch)
                    .appendQueryParameter("duration", durationSeconds.toString())
                    .build()
                    .toString()
            } catch (_: Throwable) {
                null
            }
        }

        val selectedGuideProgram = getGuideProgramForChannel(selectedChannel)
        val selectedGuideProgramEndMs = parseProgramTimestamp(selectedGuideProgram?.end)
        val selectedGuideArchiveDays = resolveArchiveDays(selectedChannel)
        val canPlaySelectedArchive =
            selectedGuideProgram != null &&
                selectedGuideProgramEndMs != null &&
                selectedGuideProgramEndMs <= System.currentTimeMillis() &&
                selectedGuideArchiveDays > 0

        fun syncBounds() {
            if (categories.isEmpty()) {
                selectedCategoryIndex = 0
                selectedIndex = 0
                return
            }
            if (selectedCategoryIndex > categories.lastIndex) {
                selectedCategoryIndex = 0
            }
            val inCat = categories[selectedCategoryIndex].second
            if (inCat.isEmpty() || selectedIndex > inCat.lastIndex) {
                selectedIndex = 0
            }
        }

        fun selectByChannelId(channelId: String?): Channel? {
            if (channelId.isNullOrBlank()) {
                selectedCategoryIndex = 0
                selectedIndex = 0
                return categories.getOrNull(0)?.second?.firstOrNull()
            }
            for ((catIndex, cat) in categories.withIndex()) {
                val idx = cat.second.indexOfFirst { it.id == channelId }
                if (idx >= 0) {
                    selectedCategoryIndex = catIndex
                    selectedIndex = idx
                    return cat.second.getOrNull(idx)
                }
            }
            selectedCategoryIndex = 0
            selectedIndex = 0
            return categories.getOrNull(0)?.second?.firstOrNull()
        }

        suspend fun loadDeviceData(token: String) {
            val playlist = backend.getPlaylist(token)
            if (playlist.isEmpty()) {
                throw IllegalStateException("No channels available for this token.")
            }

            val grouped = linkedMapOf<String, MutableList<Channel>>()
            for (channel in playlist) {
                val key = normalizeGroupName(channel.groupName ?: channel.group)
                grouped.getOrPut(key) { mutableListOf() }.add(channel)
            }
            val groupedList = grouped.toList()
            val requestedChannelId = store.getLastChannelId() ?: playlist.firstOrNull()?.id

            var initialCategoryIndex = 0
            var initialIndex = 0
            var initialChannelId = playlist.firstOrNull()?.id

            if (!requestedChannelId.isNullOrBlank()) {
                for ((catIndex, cat) in groupedList.withIndex()) {
                    val idx = cat.second.indexOfFirst { it.id == requestedChannelId }
                    if (idx >= 0) {
                        initialCategoryIndex = catIndex
                        initialIndex = idx
                        initialChannelId = cat.second[idx].id
                        break
                    }
                }
            }

            channels = playlist
            nowNextMap = runCatching { backend.getNowNext(token) }.getOrElse { emptyMap() }
            epgDayByTvgId = runCatching { backend.getDayEpg(token, LocalDate.now().toString()) }.getOrElse { emptyMap() }
            favorites = store.getFavorites()
            selectedCategoryIndex = initialCategoryIndex
            selectedIndex = initialIndex
            playingChannelId = initialChannelId
            playbackOverride = null
            guideFocusTimeMs = System.currentTimeMillis()
            showList = true
            status = "Connected. Loaded ${playlist.size} channels."
            error = null
            view = ScreenView.PLAYER
        }

        suspend fun startPairingFlow() {
            view = ScreenView.PAIRING
            error = null
            status = "Generating pairing code..."
            pairCode = null
            val started = backend.startPairing(pairingDeviceName, devicePlatform)
            pairCode = started.code
            status = "Pair code active. Confirm in web-admin."

            var attempts = 0
            while (attempts < 120) {
                delay((started.pollIntervalSec * 1000L) + (attempts * 100L).coerceAtMost(3000L))
                val state = backend.getPairStatus(started.code)
                if (state.status == "PAIRED" && !state.deviceToken.isNullOrBlank()) {
                    store.setDeviceToken(state.deviceToken)
                    pairCode = null
                    loadDeviceData(state.deviceToken)
                    return
                }
                if (state.status == "EXPIRED") {
                    throw IllegalStateException("Pairing code expired")
                }
                attempts += 1
            }
            throw IllegalStateException("Pairing timeout")
        }

        fun saveApi() {
            val normalized = normalizeBaseUrl(apiBaseInput)
            if (normalized == null) {
                error = "Backend API URL invalid. Use http(s)://host:port"
                return
            }
            apiBaseInput = normalized
            apiBase = normalized
            store.setApiBaseUrl(normalized)
            store.clearDeviceToken()
            channels = emptyList()
            nowNextMap = emptyMap()
            epgDayByTvgId = emptyMap()
            selectedCategoryIndex = 0
            selectedIndex = 0
            playingChannelId = null
            playbackOverride = null
            guideFocusTimeMs = System.currentTimeMillis()
            status = "Backend API saved: $normalized"
            error = null
            view = ScreenView.MENU
        }

        fun startPairing() {
            pairingJob?.cancel()
            pairingJob = scope.launch {
                try {
                    startPairingFlow()
                } catch (_: CancellationException) {
                    // ignore cancel
                } catch (t: Throwable) {
                    error = t.message ?: "Pairing failed"
                    view = ScreenView.MENU
                } finally {
                    pairingJob = null
                }
            }
        }

        fun connectWithToken() {
            val token = tokenInput.trim()
            if (token.isBlank()) {
                error = "Enter a valid device token."
                return
            }
            scope.launch {
                try {
                    store.setDeviceToken(token)
                    loadDeviceData(token)
                    tokenInput = ""
                } catch (t: Throwable) {
                    store.clearDeviceToken()
                    error = t.message ?: "Token failed"
                }
            }
        }

        fun logout() {
            pairingJob?.cancel()
            pairingJob = null
            store.clearDeviceToken()
            channels = emptyList()
            nowNextMap = emptyMap()
            epgDayByTvgId = emptyMap()
            selectedCategoryIndex = 0
            selectedIndex = 0
            playingChannelId = null
            playbackOverride = null
            guideFocusTimeMs = System.currentTimeMillis()
            showList = true
            menuIndex = 0
            view = ScreenView.MENU
            status = "Disconnected from device token."
            error = null
            playerController.stop()
        }

        fun stepChannel(delta: Int) {
            if (categoryChannels.isEmpty()) {
                return
            }
            selectedIndex = wrapIndex(selectedIndex + delta, categoryChannels.size)
        }

        fun stepChannelAndPlay(delta: Int) {
            if (categoryChannels.isEmpty()) {
                return
            }
            val next = wrapIndex(selectedIndex + delta, categoryChannels.size)
            selectedIndex = next
            playingChannelId = categoryChannels[next].id
            playbackOverride = null
        }

        fun stepCategory(delta: Int) {
            if (categories.isEmpty()) {
                return
            }
            selectedCategoryIndex = wrapIndex(selectedCategoryIndex + delta, categories.size)
            selectedIndex = 0
        }

        fun stepGuideTimeline(delta: Int) {
            guideFocusTimeMs += delta * GUIDE_TIMELINE_STEP_MS
        }

        fun playChannelFromGuide(channel: Channel) {
            val focusedProgram = getGuideProgramForChannel(channel)
            val focusedProgramEndMs = parseProgramTimestamp(focusedProgram?.end)
            val canPlayArchive =
                focusedProgram != null &&
                    focusedProgramEndMs != null &&
                    focusedProgramEndMs <= System.currentTimeMillis() &&
                    resolveArchiveDays(channel) > 0

            if (focusedProgram != null && canPlayArchive) {
                val archiveUrl = buildArchiveUrl(channel, focusedProgram)
                if (!archiveUrl.isNullOrBlank()) {
                    playbackOverride = PlaybackOverride(
                        channelId = channel.id,
                        url = archiveUrl,
                        label = "${focusedProgram.title ?: "Arhiva"} (${formatProgramRange(focusedProgram)})"
                    )
                    playingChannelId = channel.id
                    showList = false
                    status = "Arhiva: ${channel.name}"
                    return
                }
            }

            playbackOverride = null
            playingChannelId = channel.id
            showList = false
        }

        LaunchedEffect(categories.size, categoryChannels.size) {
            syncBounds()
        }

        LaunchedEffect(apiBase) {
            val token = store.getDeviceToken()
            if (token.isNullOrBlank()) {
                status =
                    if (deviceFingerprint.isNullOrBlank()) {
                        "Restoring device from database..."
                    } else {
                        "Restoring device from database ($deviceFingerprint)..."
                    }
                val restored = runCatching {
                    backend.restoreDeviceToken(devicePlatform, deviceFingerprint, pairingDeviceName)
                }.getOrNull()
                if (restored?.restored == true && !restored.deviceToken.isNullOrBlank()) {
                    try {
                        store.setDeviceToken(restored.deviceToken)
                        loadDeviceData(restored.deviceToken)
                        status =
                            if (restored.deviceName.isNullOrBlank()) {
                                "Device restored from database."
                            } else {
                                "Device restored: ${restored.deviceName}"
                            }
                        return@LaunchedEffect
                    } catch (_: Throwable) {
                        store.clearDeviceToken()
                    }
                }
                status = null
                view = ScreenView.MENU
                return@LaunchedEffect
            }
            try {
                loadDeviceData(token)
            } catch (t: Throwable) {
                store.clearDeviceToken()
                error = t.message ?: "Saved token is invalid."
                view = ScreenView.MENU
            }
        }

        LaunchedEffect(view) {
            if (view != ScreenView.PLAYER) {
                return@LaunchedEffect
            }
            val token = store.getDeviceToken() ?: return@LaunchedEffect
            while (true) {
                delay(60_000L)
                nowNextMap = runCatching { backend.getNowNext(token) }.getOrElse { nowNextMap }
                if (showList) {
                    epgDayByTvgId = runCatching { backend.getDayEpg(token, LocalDate.now().toString()) }.getOrElse { epgDayByTvgId }
                }
            }
        }

        LaunchedEffect(view, playingChannel?.id, playbackOverride?.url) {
            if (view != ScreenView.PLAYER) {
                return@LaunchedEffect
            }
            val channel = playingChannel ?: return@LaunchedEffect
            val playbackUrl =
                if (playbackOverride?.channelId == channel.id && !playbackOverride?.url.isNullOrBlank()) {
                    playbackOverride?.url ?: channel.url
                } else {
                    channel.url
                }
            try {
                playerController.play(playbackUrl)
                store.setLastChannelId(channel.id)
                val token = store.getDeviceToken()
                if (!token.isNullOrBlank()) {
                    backend.sendTelemetry(token, "playback_started", JSONObject().put("channelId", channel.id))
                }
            } catch (t: Throwable) {
                error = t.message ?: "Stream unsupported"
            }
        }

        DisposableEffect(Unit) {
            onDispose {
                pairingJob?.cancel()
                playerController.release()
            }
        }

        fun onAction(action: String): Boolean {
            when (view) {
                ScreenView.PLAYER -> {
                    if (categoryChannels.isEmpty()) return false
                    if (!showList && (action == "UP" || action == "LEFT" || action == "CHANNEL_UP" || action == "REWIND")) {
                        stepChannelAndPlay(-1); return true
                    }
                    if (!showList && (action == "DOWN" || action == "RIGHT" || action == "CHANNEL_DOWN" || action == "FAST_FORWARD")) {
                        stepChannelAndPlay(1); return true
                    }
                    if (showList && action == "UP") {
                        stepChannel(-1); return true
                    }
                    if (showList && action == "DOWN") {
                        stepChannel(1); return true
                    }
                    if (showList && action == "REWIND") {
                        stepGuideTimeline(-1); return true
                    }
                    if (showList && action == "FAST_FORWARD") {
                        stepGuideTimeline(1); return true
                    }
                    if (showList && action == "LEFT") {
                        stepCategory(-1); return true
                    }
                    if (showList && action == "RIGHT") {
                        stepCategory(1); return true
                    }
                    if (action == "ENTER") {
                        if (!showList) {
                            val current = selectByChannelId(playingChannelId)
                            if (current != null) {
                                playingChannelId = current.id
                            }
                            showList = true
                            return true
                        }
                        val channel = selectedChannel ?: return true
                        playChannelFromGuide(channel)
                        return true
                    }
                    if (action == "MENU") {
                        val targetChannel = if (showList) selectedChannel else playingChannel
                        targetChannel?.let { favorites = store.toggleFavorite(it.id) }
                        return true
                    }
                    if (action == "PAUSE") {
                        playerController.pause()
                        return true
                    }
                    if (action == "PLAY") {
                        val channel = playingChannel ?: return true
                        val playbackUrl =
                            if (playbackOverride?.channelId == channel.id && !playbackOverride?.url.isNullOrBlank()) {
                                playbackOverride?.url ?: channel.url
                            } else {
                                channel.url
                            }
                        playerController.play(playbackUrl)
                        return true
                    }
                    if (action == "PLAY_PAUSE") {
                        if (exoPlayer.isPlaying) {
                            playerController.pause()
                        } else {
                            val channel = playingChannel ?: return true
                            val playbackUrl =
                                if (playbackOverride?.channelId == channel.id && !playbackOverride?.url.isNullOrBlank()) {
                                    playbackOverride?.url ?: channel.url
                                } else {
                                    channel.url
                                }
                            playerController.play(playbackUrl)
                        }
                        return true
                    }
                    if (action == "STOP") {
                        playerController.stop()
                        showList = true
                        return true
                    }
                    if (action == "MUTE") {
                        exoPlayer.volume = if (exoPlayer.volume > 0f) 0f else 1f
                        return true
                    }
                    if (action == "BACK") {
                        if (showList) {
                            showList = false
                            return true
                        }
                        logout(); return true
                    }
                }
                ScreenView.MENU -> {
                    if (action == "UP" || action == "DOWN") { menuIndex = 0; return true }
                    if (action == "ENTER") {
                        startPairing()
                        return true
                    }
                    if (action == "BACK") { finish(); return true }
                }
                ScreenView.TOKEN -> {
                    if (action == "UP") { tokenIndex = wrapIndex(tokenIndex - 1, 3); return true }
                    if (action == "DOWN") { tokenIndex = wrapIndex(tokenIndex + 1, 3); return true }
                    if (action == "ENTER") {
                        when (tokenIndex) {
                            1 -> connectWithToken()
                            2 -> { menuIndex = 0; view = ScreenView.MENU }
                        }
                        return true
                    }
                    if (action == "BACK") { menuIndex = 0; view = ScreenView.MENU; return true }
                }
                ScreenView.PAIRING -> {
                    if (action == "ENTER" || action == "BACK") {
                        pairingJob?.cancel()
                        pairCode = null
                        menuIndex = 0
                        view = ScreenView.MENU
                        return true
                    }
                }
            }
            return false
        }

        val root = Modifier
            .fillMaxSize()
            .background(Color(0xFF101825))
            .padding(12.dp)
            .onPreviewKeyEvent { event ->
                if (event.nativeKeyEvent.action != AndroidKeyEvent.ACTION_DOWN) {
                    return@onPreviewKeyEvent false
                }
                when (event.nativeKeyEvent.keyCode) {
                    AndroidKeyEvent.KEYCODE_MEDIA_REWIND -> return@onPreviewKeyEvent onAction("REWIND")
                    AndroidKeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> return@onPreviewKeyEvent onAction("FAST_FORWARD")
                    AndroidKeyEvent.KEYCODE_CHANNEL_UP -> return@onPreviewKeyEvent onAction("CHANNEL_UP")
                    AndroidKeyEvent.KEYCODE_CHANNEL_DOWN -> return@onPreviewKeyEvent onAction("CHANNEL_DOWN")
                    AndroidKeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> return@onPreviewKeyEvent onAction("PLAY_PAUSE")
                    AndroidKeyEvent.KEYCODE_MEDIA_PLAY -> return@onPreviewKeyEvent onAction("PLAY")
                    AndroidKeyEvent.KEYCODE_MEDIA_PAUSE -> return@onPreviewKeyEvent onAction("PAUSE")
                    AndroidKeyEvent.KEYCODE_MEDIA_STOP -> return@onPreviewKeyEvent onAction("STOP")
                    AndroidKeyEvent.KEYCODE_MUTE -> return@onPreviewKeyEvent onAction("MUTE")
                }
                when (event.key) {
                    Key.DirectionUp -> onAction("UP")
                    Key.DirectionDown -> onAction("DOWN")
                    Key.DirectionLeft -> onAction("LEFT")
                    Key.DirectionRight -> onAction("RIGHT")
                    Key.Enter, Key.NumPadEnter -> onAction("ENTER")
                    Key.Menu -> onAction("MENU")
                    Key.Back, Key.Escape -> onAction("BACK")
                    else -> false
                }
            }

        when (view) {
            ScreenView.MENU -> {
                Box(root, contentAlignment = Alignment.TopCenter) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xE1080C14), RoundedCornerShape(14.dp))
                            .border(1.dp, Color(0x665B91BE), RoundedCornerShape(14.dp))
                            .padding(16.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.Bottom
                        ) {
                            Column {
                                Text("AccountTV", color = Color(0xFF90E3FF), style = MaterialTheme.typography.headlineSmall)
                                Text("IPTV Android Dashboard", color = Color.White, style = MaterialTheme.typography.titleLarge)
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("Home", color = Color(0xFFD3E1EF))
                                Text("Devices", color = Color(0xFFD3E1EF))
                                Text("Support", color = Color(0xFFD3E1EF))
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                        Text("Client flow simplificat: doar Pair with code.", color = Color(0xFFD3E1EF))
                        Spacer(Modifier.height(12.dp))

                        MenuDashboardTile(
                            title = "Pair with code",
                            subtitle = "Perecheaza dispozitivul in dashboard-ul firmei si incarca automat canalele.",
                            selected = menuIndex == 0,
                            modifier = Modifier.fillMaxWidth(),
                            primary = true,
                            onClick = {
                                menuIndex = 0
                                startPairing()
                            }
                        )

                        Spacer(Modifier.height(10.dp))
                        Spacer(Modifier.height(8.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { startPairing() }) { Text("Pair with code") }
                        }
                        if (!status.isNullOrBlank()) {
                            Spacer(Modifier.height(10.dp))
                            Text(status!!, color = Color(0xFFD3FFE8))
                        }
                        if (!error.isNullOrBlank()) {
                            Spacer(Modifier.height(8.dp))
                            Text(error!!, color = Color(0xFFFFD7D7))
                        }
                    }
                }
            }
            ScreenView.PAIRING -> {
                Box(root, contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Pair this $deviceName", color = Color.White, style = MaterialTheme.typography.headlineSmall)
                        Spacer(Modifier.height(10.dp))
                        Text(pairCode ?: "...", color = Color(0xFFFFC266), style = MaterialTheme.typography.displaySmall)
                        Spacer(Modifier.height(8.dp))
                        Text("Confirm code in web-admin.", color = Color(0xFFD6E2F0))
                        if (!pairingUrl.isNullOrBlank()) {
                            Spacer(Modifier.height(8.dp))
                            Text(pairingUrl, color = Color(0xFFD6E2F0))
                            Spacer(Modifier.height(8.dp))
                            OutlinedButton(onClick = {
                                clipboard.setText(AnnotatedString(pairingUrl))
                                status = "Web-admin URL copied."
                            }) {
                                Text("Copy web-admin URL")
                            }
                        }
                        if (!status.isNullOrBlank()) {
                            Spacer(Modifier.height(8.dp))
                            Text(status!!, color = Color(0xFFD3FFE8))
                        }
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = {
                            pairingJob?.cancel()
                            pairCode = null
                            menuIndex = 0
                            view = ScreenView.MENU
                        }) { Text("Cancel") }
                    }
                }
            }
            ScreenView.TOKEN -> {
                Box(root, contentAlignment = Alignment.Center) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xE1080C14), RoundedCornerShape(14.dp))
                            .border(1.dp, Color(0x665B91BE), RoundedCornerShape(14.dp))
                            .padding(16.dp)
                    ) {
                        Text("Connect using device token", color = Color.White, style = MaterialTheme.typography.headlineSmall)
                        Spacer(Modifier.height(10.dp))
                        OutlinedTextField(
                            value = tokenInput,
                            onValueChange = { tokenInput = it },
                            label = { Text("Device token") },
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(Modifier.height(6.dp))
                        Text("Dev shortcut: token implicit = test", color = Color(0xFFD3E1EF))
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { connectWithToken() }) { Text("Connect") }
                            OutlinedButton(onClick = { menuIndex = 0; view = ScreenView.MENU }) { Text("Back") }
                        }
                        if (!error.isNullOrBlank()) {
                            Spacer(Modifier.height(8.dp))
                            Text(error!!, color = Color(0xFFFFD7D7))
                        }
                    }
                }
            }
            ScreenView.PLAYER -> {
                Column(root) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(if (showList) 1f else 2f)
                            .background(Color.Black, RoundedCornerShape(12.dp))
                    ) {
                        AndroidView(
                            factory = { context ->
                                PlayerView(context).apply {
                                    useController = false
                                    player = exoPlayer
                                }
                            },
                            modifier = Modifier.fillMaxSize()
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xF0161B2D), RoundedCornerShape(10.dp))
                            .padding(10.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(playingChannel?.name ?: "No channel selected", color = Color.White, fontWeight = FontWeight.Bold)
                        Text(
                            if (showList) "ENTER play | REW/FF timp ghid" else "UP/DOWN canal | OK lista | CH+/- canal",
                            color = Color(0xFFD3E1EF)
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Now: ${nowNext?.now?.title ?: "N/A"}", color = Color.White, fontWeight = FontWeight.SemiBold)
                    Text("Next: ${nowNext?.next?.title ?: "N/A"}", color = Color(0xFFD4DEE8))
                    if (playbackOverride != null) {
                        Text("Arhiva activa: ${playbackOverride?.label.orEmpty()}", color = Color(0xFFFFDFA5))
                    }
                    if (!error.isNullOrBlank()) {
                        Spacer(Modifier.height(8.dp))
                        Text(error!!, color = Color(0xFFFFD7D7))
                    }
                    if (showList) {
                        Spacer(Modifier.height(10.dp))
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                                .background(Color(0xFF0F1728), RoundedCornerShape(12.dp))
                                .padding(12.dp)
                        ) {
                            Text("Categorii / Ghid", color = Color.White, style = MaterialTheme.typography.titleLarge)
                            Text("${categories.getOrNull(selectedCategoryIndex)?.first ?: "-"} (${selectedCategoryIndex + 1}/${categories.size.coerceAtLeast(1)})", color = Color(0xFFD3E1EF))
                            Text("${if (categoryChannels.isNotEmpty()) selectedIndex + 1 else 0} / ${categoryChannels.size}", color = Color(0xFFD3E1EF))
                            Text("Focus timp: ${formatTimeFromTimestamp(guideFocusTimeMs)}", color = Color(0xFFD3E1EF))
                            Text("LEFT/RIGHT categorie | REW/FF timp | ENTER live/arhiva", color = Color(0xFFBFD4ED))
                            Text(
                                "Program focus: ${selectedGuideProgram?.title ?: "EPG indisponibil"} (${formatProgramRange(selectedGuideProgram)})",
                                color = Color.White
                            )
                            Text(
                                if (canPlaySelectedArchive) "Arhiva disponibila (${selectedGuideArchiveDays} zile)" else "Arhiva indisponibila",
                                color = if (canPlaySelectedArchive) Color(0xFFFFDFA5) else Color(0xFFBFD4ED)
                            )
                            Spacer(Modifier.height(8.dp))
                            LazyColumn(modifier = Modifier.fillMaxWidth().weight(1f)) {
                                itemsIndexed(visibleChannels) { index, channel ->
                                    val absoluteIndex = visibleStart + index
                                    val selected = absoluteIndex == selectedIndex
                                    val favorite = favorites.contains(channel.id)
                                    val focusedProgram = getGuideProgramForChannel(channel)
                                    val focusedProgramEndMs = parseProgramTimestamp(focusedProgram?.end)
                                    val canArchive =
                                        focusedProgram != null &&
                                            focusedProgramEndMs != null &&
                                            focusedProgramEndMs <= System.currentTimeMillis() &&
                                            resolveArchiveDays(channel) > 0
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(vertical = 4.dp)
                                            .background(if (selected) Color(0xFF224164) else Color(0xFF16263B), RoundedCornerShape(10.dp))
                                            .border(if (selected) 2.dp else 1.dp, if (selected) Color(0xFFF4B447) else Color(0xFF2B3F56), RoundedCornerShape(10.dp))
                                            .clickable {
                                                selectedIndex = absoluteIndex
                                            }
                                            .padding(10.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            Text(channel.name, color = Color.White)
                                            Text(
                                                "${focusedProgram?.title ?: "Fara EPG"} (${formatProgramRange(focusedProgram)})",
                                                color = Color(0xFFD3E1EF)
                                            )
                                            if (canArchive) {
                                                Text("ARHIVA", color = Color(0xFFFFDFA5), fontWeight = FontWeight.Bold)
                                            }
                                        }
                                        OutlinedButton(onClick = { favorites = store.toggleFavorite(channel.id) }) {
                                            Text(if (favorite) "Fav" else "+Fav")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MenuDashboardTile(
    title: String,
    subtitle: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    onClick: () -> Unit
) {
    val baseColor = if (primary) Color(0xFF234B7A) else Color(0xFF16263B)
    val selectedColor = if (primary) Color(0xFF2D6199) else Color(0xFF224164)
    val borderColor = if (selected) Color(0xFFF4B447) else Color(0xFF2B3F56)

    Column(
        modifier = modifier
            .height(108.dp)
            .background(if (selected) selectedColor else baseColor, RoundedCornerShape(12.dp))
            .border(if (selected) 2.dp else 1.dp, borderColor, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        Text(subtitle, color = Color(0xFFD3E1EF), style = MaterialTheme.typography.bodyMedium)
    }
}

private fun wrapIndex(next: Int, length: Int): Int {
    if (length <= 0) return 0
    return (next % length + length) % length
}

private fun normalizeGroupName(value: String?): String {
    val normalized = value?.trim().orEmpty()
    return if (normalized.isBlank()) "Fara categorie" else normalized
}

private fun normalizeBaseUrl(value: String): String? {
    val trimmed = value.trim().trimEnd('/')
    if (trimmed.isBlank()) return null
    val uri = Uri.parse(trimmed)
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    if (uri.host.isNullOrBlank()) return null
    return trimmed
}

private fun buildWebAdminPairUrl(apiBase: String, pairCode: String?): String? {
    if (pairCode.isNullOrBlank()) {
        return null
    }

    val normalized = normalizeBaseUrl(apiBase) ?: return null
    val uri = Uri.parse(normalized)
    val scheme = uri.scheme ?: "http"
    val host = uri.host ?: return null
    return "$scheme://$host:5175/?pairCode=${Uri.encode(pairCode)}"
}
