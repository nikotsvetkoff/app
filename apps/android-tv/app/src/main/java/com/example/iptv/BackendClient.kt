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
                        logo = item.optString("logo", null),
                        group = item.optString("group", null),
                        groupName = item.optString("groupName", null),
                        tvgId = item.optString("tvgId", null),
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
                        now = item.optJSONObject("now")?.toProgramInfo(),
                        next = item.optJSONObject("next")?.toProgramInfo()
                    )
                )
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
            title = optString("title", null),
            start = optString("start", null),
            end = optString("end", null)
        )
    }

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
