package com.example.iptv

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.concurrent.TimeUnit

class BackendClient(
    context: Context,
    private val baseUrl: String = BuildConfig.API_BASE_URL
) {
    private val client = OkHttpClient.Builder()
        .callTimeout(12, TimeUnit.SECONDS)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()

    suspend fun startPairing(deviceName: String, platform: String): PairStartResponse = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("deviceName", deviceName)
            .put("platform", platform)
            .toString()

        val responseJson = request("/devices/pair/start", "POST", body)
        PairStartResponse(
            code = responseJson.getString("code"),
            expiresAt = responseJson.getString("expiresAt"),
            pollIntervalSec = responseJson.optInt("pollIntervalSec", 3)
        )
    }

    suspend fun getPairStatus(code: String): PairStatusResponse = withContext(Dispatchers.IO) {
        val responseJson = request("/devices/pair/status?code=$code", "GET")
        PairStatusResponse(
            status = responseJson.getString("status"),
            deviceToken = responseJson.optString("deviceToken", null)
        )
    }

    suspend fun restoreDeviceToken(
        platform: String,
        fingerprint: String? = null,
        deviceName: String? = null
    ): DeviceRestoreResponse = withContext(Dispatchers.IO) {
        val queryParts = mutableListOf("platform=${encodeQuery(platform)}")
        if (!fingerprint.isNullOrBlank()) {
            queryParts += "fingerprint=${encodeQuery(fingerprint)}"
        }
        if (!deviceName.isNullOrBlank()) {
            queryParts += "name=${encodeQuery(deviceName)}"
        }

        val responseJson = request("/devices/restore-token?${queryParts.joinToString("&")}", "GET")
        DeviceRestoreResponse(
            restored = responseJson.optBoolean("restored", false),
            deviceToken = responseJson.optStringOrNull("deviceToken"),
            deviceName = responseJson.optStringOrNull("deviceName")
        )
    }

    suspend fun getPlaylist(deviceToken: String): List<Channel> = withContext(Dispatchers.IO) {
        val responseJson = request("/device/playlist", "GET", deviceToken = deviceToken)
        val channels = responseJson.optJSONArray("channels") ?: JSONArray()

        buildList {
            for (index in 0 until channels.length()) {
                val item = channels.getJSONObject(index)
                add(
                    Channel(
                        id = item.getString("id"),
                        name = item.getString("name"),
                        logo = item.optStringOrNull("logo"),
                        group = item.optStringOrNull("group"),
                        groupName = item.optStringOrNull("groupName"),
                        tvgId = item.optStringOrNull("tvgId"),
                        catchup = item.optStringOrNull("catchup"),
                        catchupDays = item.optIntOrNull("catchupDays"),
                        catchupSource = item.optStringOrNull("catchupSource"),
                        catchupCorrection = item.optDoubleOrNull("catchupCorrection"),
                        url = item.getString("url")
                    )
                )
            }
        }
    }

    suspend fun getNowNext(deviceToken: String): Map<String, NowNextItem> = withContext(Dispatchers.IO) {
        val responseJson = request("/device/epg/now-next", "GET", deviceToken = deviceToken)
        val items = responseJson.optJSONArray("items") ?: JSONArray()

        buildMap {
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                val channelId = item.optString("channelId")
                if (channelId.isBlank()) {
                    continue
                }

                put(
                    channelId,
                    NowNextItem(
                        channelId = channelId,
                        channelTvgId = item.optStringOrNull("channelTvgId"),
                        channelLogo = item.optStringOrNull("channelLogo"),
                        now = item.optJSONObject("now")?.toProgramInfo(),
                        next = item.optJSONObject("next")?.toProgramInfo()
                    )
                )
            }
        }
    }

    suspend fun getDayEpg(deviceToken: String, dateKey: String): Map<String, List<ProgramInfo>> =
        withContext(Dispatchers.IO) {
            val responseJson = request("/device/epg/day?date=$dateKey", "GET", deviceToken = deviceToken)
            val items = responseJson.optJSONArray("items") ?: JSONArray()

            buildMap {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index) ?: continue
                    val channelTvgId = item.optString("channelTvgId", "").trim().lowercase()
                    if (channelTvgId.isBlank()) {
                        continue
                    }

                    val programsArray = item.optJSONArray("programs") ?: JSONArray()
                    val programs = buildList {
                        for (programIndex in 0 until programsArray.length()) {
                            val programObject = programsArray.optJSONObject(programIndex) ?: continue
                            val program = programObject.toProgramInfo()
                            val startMs = parseProgramTimestamp(program.start)
                            val endMs = parseProgramTimestamp(program.end)
                            if (program.title.isNullOrBlank() || startMs == null || endMs == null || endMs <= startMs) {
                                continue
                            }
                            add(program)
                        }
                    }.sortedBy { parseProgramTimestamp(it.start) ?: Long.MAX_VALUE }

                    if (programs.isNotEmpty()) {
                        put(channelTvgId, programs)
                    }
                }
            }
        }

    suspend fun sendTelemetry(deviceToken: String, type: String, payload: JSONObject = JSONObject()) {
        withContext(Dispatchers.IO) {
            request(
                path = "/telemetry/event",
                method = "POST",
                body = JSONObject().put("type", type).put("payload", payload).toString(),
                deviceToken = deviceToken
            )
        }
    }

    private fun JSONObject.toProgramInfo(): ProgramInfo {
        return ProgramInfo(
            title = optStringOrNull("title"),
            start = optStringOrNull("start"),
            end = optStringOrNull("end"),
            description = optStringOrNull("description")
        )
    }

    private fun JSONObject.optStringOrNull(key: String): String? {
        val value = optString(key, "").trim()
        return value.takeIf { it.isNotEmpty() }
    }

    private fun JSONObject.optIntOrNull(key: String): Int? {
        if (!has(key) || isNull(key)) {
            return null
        }
        val fromNumber = runCatching { getInt(key) }.getOrNull()
        if (fromNumber != null && fromNumber > 0) {
            return fromNumber
        }
        val fromString = optStringOrNull(key)?.toIntOrNull()
        return fromString?.takeIf { it > 0 }
    }

    private fun JSONObject.optDoubleOrNull(key: String): Double? {
        if (!has(key) || isNull(key)) {
            return null
        }
        val fromNumber = runCatching { getDouble(key) }.getOrNull()
        if (fromNumber != null && fromNumber.isFinite()) {
            return fromNumber
        }
        return optStringOrNull(key)?.toDoubleOrNull()?.takeIf { it.isFinite() }
    }

    private fun parseProgramTimestamp(value: String?): Long? {
        if (value.isNullOrBlank()) {
            return null
        }
        return runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
    }

    private fun encodeQuery(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.toString())

    private fun request(
        path: String,
        method: String,
        body: String? = null,
        deviceToken: String? = null
    ): JSONObject {
        val builder = Request.Builder().url("$baseUrl$path")

        if (deviceToken != null) {
            builder.addHeader("x-device-token", deviceToken)
        }

        when (method) {
            "POST" -> builder.post((body ?: "{}").toRequestBody(jsonType))
            else -> builder.get()
        }

        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) {
                val errorBody = response.body?.string().orEmpty()
                throw IllegalStateException("Request failed: ${response.code} $errorBody")
            }
            val payload = response.body?.string().orEmpty()
            return JSONObject(payload)
        }
    }
}
