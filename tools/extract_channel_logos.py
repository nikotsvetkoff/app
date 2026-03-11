#!/usr/bin/env python3
"""
Extract channel logos in best available quality.

Input sources:
1) M3U playlist file (`--playlist-file`) or URL (`--playlist-url`)
2) Backend backup JSON (`--backup-file`) for channel list and OTT logo fallbacks

If no playlist source is given, the script reads channels from `basePlaylistCaches`
in the backup (useful for uploaded-file:// playlists already cached by backend).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

UPLOADED_PLAYLIST_URL_PREFIX = "uploaded-file://"
QUALITY_TOKENS = {"uhd", "fhd", "hd", "sd", "4k", "hevc", "h265", "hdr", "dovi"}
COUNTRY_TOKENS = {
    "md",
    "ro",
    "ru",
    "ua",
    "tr",
    "lt",
    "se",
    "de",
    "fr",
    "it",
    "es",
    "pl",
    "cz",
    "hu",
    "bg",
    "uk",
    "us",
}
GENERIC_NAME_TOKENS = {"tv", "channel", "live"}
NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
EXTINF_ATTR_RE = re.compile(r'([A-Za-z0-9_-]+)="([^"]*)"')
PNG_SIG = b"\x89PNG\r\n\x1a\n"

IMAGE_EXT_BY_FORMAT = {
    "png": ".png",
    "jpg": ".jpg",
    "jpeg": ".jpg",
    "webp": ".webp",
    "gif": ".gif",
    "svg": ".svg",
    "bmp": ".bmp",
    "avif": ".avif",
}


@dataclass
class Channel:
    index: int
    name: str
    stream_url: str
    group: str | None = None
    tvg_id: str | None = None
    logo_url: str | None = None


@dataclass
class FetchedImage:
    ok: bool
    url: str
    reason: str | None = None
    status: int | None = None
    mime: str | None = None
    image_format: str | None = None
    width: int | None = None
    height: int | None = None
    data: bytes | None = None


def normalize_tvg_id(value: str | None) -> str:
    return (value or "").strip().lower()


def strip_accents(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_channel_name(value: str, drop_quality_tokens: bool = True) -> str:
    text = strip_accents(value or "").lower().replace("ё", "е")
    text = NON_WORD_RE.sub(" ", text).strip()
    if not drop_quality_tokens:
        return re.sub(r"\s+", " ", text).strip()
    tokens = [token for token in text.split() if token and token not in QUALITY_TOKENS]
    return " ".join(tokens).strip()


def slugify(value: str) -> str:
    text = normalize_channel_name(value, drop_quality_tokens=False)
    text = text.replace(" ", "-")
    text = re.sub(r"-{2,}", "-", text).strip("-")
    if not text:
        return "channel"
    return text[:80]


def dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def safe_console_text(value: str) -> str:
    encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        return value.encode(encoding, errors="replace").decode(encoding, errors="replace")
    except Exception:  # noqa: BLE001
        return value.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def clean_optional_str(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        if text and text.lower() not in {"none", "null"}:
            return text
    return None


def unique_tokens(tokens: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        output.append(token)
    return output


def generate_token_ngrams(tokens: list[str], min_len: int = 2, max_len: int = 6) -> list[str]:
    if not tokens:
        return []
    max_size = min(max_len, len(tokens))
    output: list[str] = []
    for size in range(max(min_len, 1), max_size + 1):
        for start in range(0, len(tokens) - size + 1):
            output.append(" ".join(tokens[start : start + size]))
    return output


def split_compound_tv_tokens(tokens: list[str]) -> list[str]:
    expanded: list[str] = []
    for token in tokens:
        if token != "tv" and token.endswith("tv") and len(token) > 2 and token[:-2].isalpha():
            expanded.append(token[:-2])
            expanded.append("tv")
        else:
            expanded.append(token)
    return expanded


def build_name_variants(value: str) -> list[str]:
    base = normalize_channel_name(value, drop_quality_tokens=True)
    if not base:
        return []
    tokens = [token for token in base.split() if token]
    if not tokens:
        return []

    split_tv = split_compound_tv_tokens(tokens)

    variants: list[str] = []
    variants.append(" ".join(tokens))
    variants.append(" ".join(split_tv))

    # Remove repeated neighbors: "moldova 1 moldova 1" -> "moldova 1 moldova 1" (unchanged),
    # but "tv tv8" style noise is reduced.
    collapsed_neighbors: list[str] = []
    for token in tokens:
        if collapsed_neighbors and collapsed_neighbors[-1] == token:
            continue
        collapsed_neighbors.append(token)
    variants.append(" ".join(collapsed_neighbors))

    unique = unique_tokens(tokens)
    variants.append(" ".join(unique))

    no_country = [token for token in tokens if token not in COUNTRY_TOKENS]
    if no_country:
        variants.append(" ".join(no_country))
        variants.append(" ".join(unique_tokens(no_country)))

    no_generic = [token for token in no_country if token not in GENERIC_NAME_TOKENS]
    if no_generic:
        variants.append(" ".join(no_generic))
        variants.append(" ".join(unique_tokens(no_generic)))

    variants.extend(generate_token_ngrams(tokens))
    variants.extend(generate_token_ngrams(split_tv))

    return dedupe_preserve_order([variant.strip() for variant in variants if variant.strip()])


def find_latest_backup(backup_dir: Path) -> Path:
    candidates = sorted(backup_dir.glob("backup-*-auto-scheduled.json"))
    if not candidates:
        raise FileNotFoundError(
            f"No auto-scheduled backups found in '{backup_dir.as_posix()}'."
        )
    return candidates[-1]


def load_backup_data(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and isinstance(raw.get("data"), dict):
        return raw["data"]
    if isinstance(raw, dict):
        return raw
    raise ValueError("Backup JSON has unsupported format.")


def read_text_url(url: str, timeout: float) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": "channel-logo-extractor/1.0",
            "Accept": "text/plain,application/octet-stream,*/*",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
    return payload.decode(charset, errors="replace")


def parse_extinf_line(line: str) -> dict[str, str]:
    payload = line[len("#EXTINF:") :]
    if "," in payload:
        attrs_part, display_name = payload.split(",", 1)
    else:
        attrs_part, display_name = payload, ""
    attrs = {key.lower(): value.strip() for key, value in EXTINF_ATTR_RE.findall(attrs_part)}
    attrs["name"] = display_name.strip() or attrs.get("tvg-name", "").strip()
    return attrs


def parse_m3u_channels(m3u_text: str) -> list[Channel]:
    channels: list[Channel] = []
    pending: dict[str, str] | None = None

    for raw_line in m3u_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            pending = parse_extinf_line(line)
            continue
        if line.startswith("#"):
            continue
        if pending is None:
            continue

        name = pending.get("name", "").strip()
        if not name:
            pending = None
            continue

        channels.append(
            Channel(
                index=len(channels) + 1,
                name=name,
                stream_url=line,
                group=(pending.get("group-title") or None),
                tvg_id=(pending.get("tvg-id") or None),
                logo_url=(pending.get("tvg-logo") or None),
            )
        )
        pending = None

    return channels


def pick_backup_playlist(
    backup_data: dict[str, Any], playlist_name: str | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    playlists = backup_data.get("basePlaylists")
    caches = backup_data.get("basePlaylistCaches")
    if not isinstance(playlists, list) or not playlists:
        raise ValueError("Backup has no basePlaylists.")
    if not isinstance(caches, list) or not caches:
        raise ValueError("Backup has no basePlaylistCaches.")

    selected: dict[str, Any] | None = None
    if playlist_name:
        expected = playlist_name.strip().lower()
        selected = next(
            (row for row in playlists if str(row.get("name", "")).strip().lower() == expected),
            None,
        )
        if selected is None:
            selected = next(
                (row for row in playlists if expected in str(row.get("name", "")).strip().lower()),
                None,
            )
    if selected is None:
        selected = playlists[0]

    playlist_id = selected.get("id")
    if not isinstance(playlist_id, str) or not playlist_id:
        raise ValueError("Selected base playlist has no id.")

    selected_cache = next(
        (row for row in caches if str(row.get("basePlaylistId")) == playlist_id),
        None,
    )
    if selected_cache is None:
        raise ValueError(f"No cache found for base playlist '{selected.get('name', '<unknown>')}'.")

    return selected, selected_cache


def channels_from_backup_cache(cache_row: dict[str, Any]) -> list[Channel]:
    raw_channels = cache_row.get("channelsJson")
    if not isinstance(raw_channels, list):
        raise ValueError("basePlaylistCache.channelsJson is not an array.")

    channels: list[Channel] = []
    for item in raw_channels:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        stream_url = str(item.get("url") or "").strip()
        if not name:
            continue
        channels.append(
            Channel(
                index=len(channels) + 1,
                name=name,
                stream_url=stream_url,
                group=clean_optional_str(item.get("group")),
                tvg_id=clean_optional_str(item.get("tvgId")),
                logo_url=clean_optional_str(item.get("logo")),
            )
        )

    return channels


def build_ott_logo_indexes(
    backup_data: dict[str, Any]
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    rows = backup_data.get("ottChannels")
    by_tvg: dict[str, list[str]] = {}
    by_name: dict[str, list[str]] = {}
    if not isinstance(rows, list):
        return by_tvg, by_name

    for row in rows:
        if not isinstance(row, dict):
            continue
        logo = clean_optional_str(row.get("logoUrl")) or ""
        if not logo:
            continue

        tvg_raw = clean_optional_str(row.get("tvgId")) or ""
        tvg_key = normalize_tvg_id(tvg_raw)
        display_name = clean_optional_str(row.get("displayName")) or ""

        if tvg_key:
            by_tvg.setdefault(tvg_key, []).append(logo)

        for variant in build_name_variants(display_name):
            by_name.setdefault(variant, []).append(logo)

        if tvg_raw:
            for variant in build_name_variants(tvg_raw.replace("-", " ").replace("_", " ")):
                by_name.setdefault(variant, []).append(logo)

    for key, values in list(by_tvg.items()):
        by_tvg[key] = dedupe_preserve_order(values)
    for key, values in list(by_name.items()):
        by_name[key] = dedupe_preserve_order(values)

    return by_tvg, by_name


def parse_png_size(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 24 or not data.startswith(PNG_SIG):
        return None, None
    width = int.from_bytes(data[16:20], byteorder="big")
    height = int.from_bytes(data[20:24], byteorder="big")
    return width, height


def parse_gif_size(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 10 or data[:6] not in (b"GIF87a", b"GIF89a"):
        return None, None
    width = int.from_bytes(data[6:8], byteorder="little")
    height = int.from_bytes(data[8:10], byteorder="little")
    return width, height


def parse_jpeg_size(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        return None, None

    i = 2
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    while i < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        while i < len(data) and data[i] == 0xFF:
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1

        if marker in (0xD8, 0xD9, 0x01) or (0xD0 <= marker <= 0xD7):
            continue
        if i + 2 > len(data):
            break
        segment_len = int.from_bytes(data[i : i + 2], byteorder="big")
        if segment_len < 2 or i + segment_len > len(data):
            break
        if marker in sof_markers and i + 7 <= len(data):
            height = int.from_bytes(data[i + 3 : i + 5], byteorder="big")
            width = int.from_bytes(data[i + 5 : i + 7], byteorder="big")
            return width, height
        i += segment_len
    return None, None


def parse_webp_size(data: bytes) -> tuple[int | None, int | None]:
    if len(data) < 16 or data[0:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None, None
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height
    if chunk == b"VP8 " and len(data) >= 30:
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return width, height
    if chunk == b"VP8L" and len(data) >= 25:
        b0, b1, b2, b3 = data[21:25]
        width = 1 + (((b1 & 0x3F) << 8) | b0)
        height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
        return width, height
    return None, None


def parse_svg_size(data: bytes) -> tuple[int | None, int | None]:
    if not data:
        return None, None
    head = data[:4096].decode("utf-8", errors="ignore").lower()
    if "<svg" not in head:
        return None, None
    width_match = re.search(r'width\s*=\s*["\']\s*([0-9]+(?:\.[0-9]+)?)', head)
    height_match = re.search(r'height\s*=\s*["\']\s*([0-9]+(?:\.[0-9]+)?)', head)
    width = int(float(width_match.group(1))) if width_match else None
    height = int(float(height_match.group(1))) if height_match else None
    return width, height


def detect_image(data: bytes, content_type: str | None, url: str) -> tuple[str | None, int | None, int | None]:
    ctype = (content_type or "").split(";")[0].strip().lower()

    if data.startswith(PNG_SIG):
        width, height = parse_png_size(data)
        return "png", width, height
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        width, height = parse_jpeg_size(data)
        return "jpg", width, height
    if len(data) >= 6 and data[:6] in (b"GIF87a", b"GIF89a"):
        width, height = parse_gif_size(data)
        return "gif", width, height
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        width, height = parse_webp_size(data)
        return "webp", width, height
    if data[:2] == b"BM":
        return "bmp", None, None
    if ctype == "image/svg+xml" or url.lower().endswith(".svg"):
        width, height = parse_svg_size(data)
        if width is not None or height is not None or b"<svg" in data[:4096].lower():
            return "svg", width, height
    if ctype.startswith("image/"):
        guessed = ctype.replace("image/", "").strip()
        if guessed == "jpeg":
            guessed = "jpg"
        return guessed, None, None
    return None, None, None


def fetch_image(url: str, timeout: float, max_bytes: int) -> FetchedImage:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return FetchedImage(ok=False, url=url, reason="unsupported_scheme")

    request = Request(
        url,
        headers={
            "User-Agent": "channel-logo-extractor/1.0",
            "Accept": "image/*,*/*;q=0.8",
        },
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read(max_bytes + 1)
            if len(payload) > max_bytes:
                return FetchedImage(
                    ok=False,
                    url=url,
                    status=getattr(response, "status", None),
                    reason=f"payload_too_large>{max_bytes}",
                )
            ctype = response.headers.get("Content-Type", "")
            image_format, width, height = detect_image(payload, ctype, url)
            if not image_format:
                return FetchedImage(
                    ok=False,
                    url=url,
                    status=getattr(response, "status", None),
                    mime=ctype,
                    reason="not_an_image",
                )
            return FetchedImage(
                ok=True,
                url=url,
                status=getattr(response, "status", None),
                mime=ctype,
                image_format=image_format,
                width=width,
                height=height,
                data=payload,
            )
    except HTTPError as exc:
        return FetchedImage(ok=False, url=url, status=exc.code, reason=f"http_{exc.code}")
    except URLError as exc:
        return FetchedImage(ok=False, url=url, reason=f"url_error:{exc.reason}")
    except TimeoutError:
        return FetchedImage(ok=False, url=url, reason="timeout")
    except Exception as exc:  # noqa: BLE001
        return FetchedImage(ok=False, url=url, reason=f"error:{type(exc).__name__}")


def image_score(image: FetchedImage) -> tuple[int, int, int, int, int, int]:
    if not image.ok:
        return (-1, -1, -1, -1, -1, -1)
    fmt = (image.image_format or "").lower()
    is_svg = 1 if fmt == "svg" else 0
    has_dims = 1 if (image.width and image.height) else 0
    area = (image.width or 0) * (image.height or 0)
    if is_svg and area == 0:
        area = 10_000_000
    size_bytes = len(image.data or b"")
    is_https = 1 if image.url.lower().startswith("https://") else 0
    format_rank = {"svg": 6, "png": 5, "webp": 4, "avif": 4, "jpg": 3, "jpeg": 3, "gif": 2}.get(
        fmt,
        1,
    )
    return (is_svg, has_dims, area, size_bytes, is_https, format_rank)


def build_candidates(
    channel: Channel, by_tvg: dict[str, list[str]], by_name: dict[str, list[str]]
) -> list[str]:
    candidates: list[str] = []

    if channel.logo_url:
        candidates.append(channel.logo_url.strip())

    tvg_key = normalize_tvg_id(channel.tvg_id)
    if tvg_key and tvg_key in by_tvg:
        candidates.extend(by_tvg[tvg_key])

    for variant in build_name_variants(channel.name):
        if variant in by_name:
            candidates.extend(by_name[variant])

    if tvg_key:
        candidates.append(f"https://iptvx.one/picons/{tvg_key}.png")
        candidates.append(f"http://iptvx.one/picons/{tvg_key}.png")

    filtered = []
    for value in dedupe_preserve_order(candidates):
        if value.startswith("http://") or value.startswith("https://"):
            filtered.append(value)
    return filtered


def extract_logos(
    channels: list[Channel],
    by_tvg: dict[str, list[str]],
    by_name: dict[str, list[str]],
    output_dir: Path,
    workers: int,
    timeout: float,
    max_bytes: int,
    max_candidates: int,
) -> list[dict[str, Any]]:
    logos_dir = output_dir / "logos"
    logos_dir.mkdir(parents=True, exist_ok=True)

    cache: dict[str, FetchedImage] = {}
    lock = Lock()

    def fetch_cached(url: str) -> FetchedImage:
        with lock:
            existing = cache.get(url)
        if existing is not None:
            return existing
        result = fetch_image(url=url, timeout=timeout, max_bytes=max_bytes)
        with lock:
            cache.setdefault(url, result)
            return cache[url]

    def process_channel(channel: Channel) -> dict[str, Any]:
        candidates = build_candidates(channel, by_tvg=by_tvg, by_name=by_name)[:max_candidates]

        best: FetchedImage | None = None
        attempted = 0
        failures: list[str] = []

        for candidate in candidates:
            attempted += 1
            fetched = fetch_cached(candidate)
            if not fetched.ok:
                failures.append(f"{candidate} -> {fetched.reason or 'failed'}")
                continue
            if best is None or image_score(fetched) > image_score(best):
                best = fetched

        result: dict[str, Any] = {
            "index": channel.index,
            "name": channel.name,
            "group": channel.group,
            "tvgId": channel.tvg_id,
            "streamUrl": channel.stream_url,
            "candidatesTried": attempted,
            "status": "missing",
            "savedPath": None,
            "sourceUrl": None,
            "imageFormat": None,
            "width": None,
            "height": None,
            "bytes": None,
            "reason": None,
        }

        if best is None:
            result["reason"] = failures[0] if failures else "no_candidate_logo_url"
            return result

        ext = IMAGE_EXT_BY_FORMAT.get((best.image_format or "").lower(), ".img")
        filename = f"{channel.index:04d}-{slugify(channel.name)}{ext}"
        path = logos_dir / filename
        path.write_bytes(best.data or b"")

        result["status"] = "saved"
        result["savedPath"] = str(path.as_posix())
        result["sourceUrl"] = best.url
        result["imageFormat"] = best.image_format
        result["width"] = best.width
        result["height"] = best.height
        result["bytes"] = len(best.data or b"")
        return result

    results: list[dict[str, Any]] = [None] * len(channels)  # type: ignore[list-item]
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        future_map = {executor.submit(process_channel, channel): idx for idx, channel in enumerate(channels)}
        for future in as_completed(future_map):
            idx = future_map[future]
            results[idx] = future.result()
            item = results[idx]
            status = item["status"]
            channel_name = safe_console_text(str(item["name"]))
            if status == "saved":
                print(f"[{idx + 1}/{len(channels)}] saved: {channel_name}")
            else:
                print(f"[{idx + 1}/{len(channels)}] missing: {channel_name}")
    return results


def write_reports(output_dir: Path, report_rows: list[dict[str, Any]]) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    report_json = output_dir / "report.json"
    report_csv = output_dir / "report.csv"

    report_json.write_text(json.dumps(report_rows, ensure_ascii=False, indent=2), encoding="utf-8")

    fields = [
        "index",
        "name",
        "group",
        "tvgId",
        "streamUrl",
        "status",
        "savedPath",
        "sourceUrl",
        "imageFormat",
        "width",
        "height",
        "bytes",
        "candidatesTried",
        "reason",
    ]
    with report_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in report_rows:
            writer.writerow(row)

    return report_json, report_csv


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract high-quality logos for all channels.")
    parser.add_argument("--playlist-file", help="Path to local .m3u/.m3u8 file")
    parser.add_argument("--playlist-url", help="HTTP(S) URL to .m3u/.m3u8")
    parser.add_argument(
        "--backup-file",
        help="Path to backend backup JSON. If omitted, latest backup from --backup-dir is used.",
    )
    parser.add_argument(
        "--backup-dir",
        default="apps/backend/data/backups",
        help="Directory where auto backups exist (default: apps/backend/data/backups)",
    )
    parser.add_argument(
        "--playlist-name",
        default="Moldovenesti",
        help="Base playlist name to select from backup cache (default: Moldovenesti)",
    )
    parser.add_argument(
        "--output-dir",
        default="output/channel-logos",
        help="Where to store logos and report files",
    )
    parser.add_argument("--workers", type=int, default=12, help="Concurrent download workers")
    parser.add_argument("--timeout", type=float, default=8.0, help="HTTP timeout seconds")
    parser.add_argument("--max-bytes", type=int, default=4_000_000, help="Max bytes per logo file")
    parser.add_argument("--max-candidates", type=int, default=8, help="Max logo URLs tested per channel")
    parser.add_argument("--channels-limit", type=int, default=0, help="Debug: limit channel count")
    return parser.parse_args(argv)


def load_channels(
    args: argparse.Namespace, backup_data: dict[str, Any] | None
) -> tuple[list[Channel], str]:
    if args.playlist_file:
        text = Path(args.playlist_file).read_text(encoding="utf-8", errors="replace")
        channels = parse_m3u_channels(text)
        return channels, f"playlist-file:{args.playlist_file}"

    if args.playlist_url:
        text = read_text_url(args.playlist_url, timeout=float(args.timeout))
        channels = parse_m3u_channels(text)
        return channels, f"playlist-url:{args.playlist_url}"

    if backup_data is None:
        raise ValueError("No playlist source provided. Use --playlist-file, --playlist-url, or backup data.")

    selected_playlist, selected_cache = pick_backup_playlist(backup_data, args.playlist_name)
    channels = channels_from_backup_cache(selected_cache)
    return channels, f"backup-cache:{selected_playlist.get('name', '<unknown>')}"


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    backup_data: dict[str, Any] | None = None
    backup_path: Path | None = None
    if args.backup_file:
        backup_path = Path(args.backup_file)
        backup_data = load_backup_data(backup_path)
    else:
        backup_dir = Path(args.backup_dir)
        if backup_dir.exists():
            try:
                backup_path = find_latest_backup(backup_dir)
                backup_data = load_backup_data(backup_path)
            except FileNotFoundError:
                backup_path = None
                backup_data = None

    channels, channels_source = load_channels(args, backup_data)
    if not channels:
        print("No channels found.", file=sys.stderr)
        return 1

    if args.channels_limit and args.channels_limit > 0:
        channels = channels[: args.channels_limit]

    ott_by_tvg: dict[str, list[str]] = {}
    ott_by_name: dict[str, list[str]] = {}
    if backup_data is not None:
        ott_by_tvg, ott_by_name = build_ott_logo_indexes(backup_data)

    output_dir = Path(args.output_dir)

    print(f"Channels source: {channels_source}")
    if backup_path:
        print(f"Backup source: {backup_path.as_posix()}")
    print(f"Channels count: {len(channels)}")
    print(f"OTT logo lookup: tvg={len(ott_by_tvg)}, name={len(ott_by_name)}")
    print(f"Output dir: {output_dir.as_posix()}")

    start = time.time()
    rows = extract_logos(
        channels=channels,
        by_tvg=ott_by_tvg,
        by_name=ott_by_name,
        output_dir=output_dir,
        workers=int(args.workers),
        timeout=float(args.timeout),
        max_bytes=int(args.max_bytes),
        max_candidates=int(args.max_candidates),
    )
    elapsed = time.time() - start

    report_json, report_csv = write_reports(output_dir, rows)
    saved = sum(1 for row in rows if row.get("status") == "saved")
    missing = len(rows) - saved

    summary = {
        "source": channels_source,
        "backup": backup_path.as_posix() if backup_path else None,
        "channelsTotal": len(rows),
        "savedLogos": saved,
        "missingLogos": missing,
        "elapsedSec": round(elapsed, 2),
        "reportJson": report_json.as_posix(),
        "reportCsv": report_csv.as_posix(),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("")
    print("Done.")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
