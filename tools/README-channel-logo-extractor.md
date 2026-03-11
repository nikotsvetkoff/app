# Channel Logo Extractor (Python)

Script: `tools/extract_channel_logos.py`

Ce face:
- ia toate canalele din playlist
- cauta logo pentru fiecare canal
- testeaza mai multe surse (logo din playlist + fallback din `ottChannels` din backup)
- descarca varianta cu calitate mai buna (dimensiune mai mare / format mai bun)
- salveaza raport JSON + CSV

## Rulare rapida (din acest repo)

### 1) Din backup-ul curent (recomandat pentru setup-ul tau)
```powershell
py tools/extract_channel_logos.py --playlist-name Moldovenesti --output-dir output/channel-logos-md
```

### 2) Din fisier M3U local
```powershell
py tools/extract_channel_logos.py --playlist-file "C:\path\playlist.m3u8" --output-dir output/channel-logos
```

### 3) Din URL M3U
```powershell
py tools/extract_channel_logos.py --playlist-url "https://example.com/playlist.m3u8" --output-dir output/channel-logos
```

## Optiuni utile

- `--backup-file <path>`: foloseste un backup JSON anume
- `--workers 16`: creste paralelismul
- `--timeout 10`: timeout per request
- `--max-candidates 10`: cate URL-uri de logo incearca per canal
- `--channels-limit 50`: test rapid pe primele 50 canale

## Rezultate

In folderul de output:
- `logos/` - imaginile descarcate
- `report.json` - raport complet per canal
- `report.csv` - raport pentru Excel
- `summary.json` - sumar final
