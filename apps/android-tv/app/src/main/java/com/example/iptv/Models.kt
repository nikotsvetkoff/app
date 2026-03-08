package com.example.iptv

data class Channel(
    val id: String,
    val name: String,
    val logo: String?,
    val group: String?,
    val groupName: String?,
    val tvgId: String?,
    val catchup: String?,
    val catchupDays: Int?,
    val catchupSource: String?,
    val catchupCorrection: Double?,
    val url: String
)

data class ProgramInfo(
    val title: String?,
    val start: String?,
    val end: String?,
    val description: String?
)

data class NowNextItem(
    val channelId: String,
    val channelTvgId: String?,
    val channelLogo: String?,
    val now: ProgramInfo?,
    val next: ProgramInfo?
)

data class PairStartResponse(
    val code: String,
    val expiresAt: String,
    val pollIntervalSec: Int
)

data class PairStatusResponse(
    val status: String,
    val deviceToken: String?
)

data class DeviceRestoreResponse(
    val restored: Boolean,
    val deviceToken: String?,
    val deviceName: String?
)
