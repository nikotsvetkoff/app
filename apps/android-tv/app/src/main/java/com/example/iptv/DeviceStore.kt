package com.example.iptv

import android.content.Context

class DeviceStore(context: Context) {
    private val prefs = context.getSharedPreferences("iptv_store", Context.MODE_PRIVATE)
    private val apiBaseUrlKey = "api_base_url"

    fun getDeviceToken(): String? = prefs.getString("device_token", null)

    fun setDeviceToken(token: String) {
        prefs.edit().putString("device_token", token).apply()
    }

    fun clearDeviceToken() {
        prefs.edit().remove("device_token").apply()
    }

    fun getLastChannelId(): String? = prefs.getString("last_channel_id", null)

    fun setLastChannelId(channelId: String) {
        prefs.edit().putString("last_channel_id", channelId).apply()
    }

    fun getFavorites(): Set<String> = prefs.getStringSet("favorites", emptySet()) ?: emptySet()

    fun toggleFavorite(channelId: String): Set<String> {
        val current = getFavorites().toMutableSet()
        if (current.contains(channelId)) {
            current.remove(channelId)
        } else {
            current.add(channelId)
        }
        prefs.edit().putStringSet("favorites", current).apply()
        return current
    }

    fun getApiBaseUrl(): String? = prefs.getString(apiBaseUrlKey, null)

    fun setApiBaseUrl(url: String) {
        prefs.edit().putString(apiBaseUrlKey, url).apply()
    }
}
