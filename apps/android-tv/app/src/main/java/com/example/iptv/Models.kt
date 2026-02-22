package com.example.iptv

data class Channel(
    val id: String,
    val name: String,
    val logo: String?,
    val group: String?,
    val groupName: String?,
    val tvgId: String?,
    val url: String
)

data class ProgramInfo(
    val title: String?,
    val start: String?,
    val end: String?
)

data class NowNextItem(
    val channelId: String,
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
