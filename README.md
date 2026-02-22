# IPTV Smart TV Ecosystem MVP

Monorepo production-oriented pentru un client IPTV multi-platforma:
- Android (TV + mobile + stick/box + Android x86) (Kotlin + Media3 ExoPlayer)
- Samsung Tizen (React web app + AVPlay)
- LG webOS (React web app + HTML5 video)
- MAG Linux STB (React web app + HTML5 video)

Include:
- `@iptv/core` (modele, parser M3U, logica EPG now/next, storage favorites/history, helper naviga?ie)
- `@iptv/ui` (componente React remote-first)
- backend `@iptv/backend` (NestJS + Prisma + PostgreSQL)
- `@iptv/web-admin` (panel minim pentru auth + setari surse + pairing confirm)

## 1) Prerechizite
- Node.js 20+
- Corepack activ (`corepack enable`)
- Docker + Docker Compose (pentru PostgreSQL/backend)
- Pentru packaging device:
  - Tizen Studio CLI
  - webOS CLI (`@webos-tools/cli`, provides `ares-*` commands)
  - Android Studio sau Gradle + Android SDK

## 2) Structura monorepo

```text
/
  pnpm-workspace.yaml
  package.json
  README.md
  CHANGELOG.md

  packages/
    core/
    ui/

  apps/
    backend/
    tizen/
    webos/
    mag/
    web-admin/
    android-tv/
```

## 3) Setup rapid

1. Instaleaza dependen?ele:
```bash
corepack pnpm install
```

2. Configureaza backend env:
```bash
cp apps/backend/.env.example apps/backend/.env
```

Pentru confirmarea inregistrarii admin prin Gmail, completeaza in `apps/backend/.env`:
- `SMTP_USER` = adresa Gmail care trimite email-ul
- `SMTP_PASS` = App Password Gmail (nu parola normala)
- `ADMIN_RESET_PASSWORD_BASE_URL` = URL-ul panoului web-admin pentru link reset parola
- `AUTH_TOKEN_CLEANUP_INTERVAL_SEC` = interval de curatare token-uri expirate (default 900 sec)

3. Porne?te PostgreSQL + backend cu Docker:
```bash
cd apps/backend
docker compose up -d postgres
```

4. Ruleaza migra?iile + backend local:
```bash
corepack pnpm --filter @iptv/backend prisma:generate
corepack pnpm --filter @iptv/backend prisma:deploy
corepack pnpm --filter @iptv/backend dev
```

Swagger disponibil la:
- `http://localhost:3000/docs`

## 4) Cum rulezi fiecare aplica?ie local

### Backend
```bash
corepack pnpm --filter @iptv/backend dev
```

### Web Admin (onboarding user)
```bash
corepack pnpm --filter @iptv/web-admin dev
```
Default: `http://localhost:5175`

### Tizen app
```bash
corepack pnpm --filter @iptv/tizen dev
```
Default: `http://localhost:5173`

### webOS app
```bash
corepack pnpm --filter @iptv/webos dev
```
Default: `http://localhost:5174`

### MAG app
```bash
corepack pnpm --filter @iptv/mag dev
```
Default: `http://localhost:5176`
Nota: profilul curent este optimizat pentru MAG250 (key mapping remote inclus).

### Android app (TV + mobile + box + Android x86)
Deschide `apps/android-tv` in Android Studio si ruleaza `app` pe emulator sau device Android.

API base default in debug:
- Android: `http://10.0.2.2:3000` (doar emulator; pe device real seteaza URL din ecranul principal)
- Web apps: `http://localhost:3000` (override cu `VITE_API_BASE_URL` daca e nevoie)
- Pentru telefon + PC pe USB: `adb reverse tcp:3000 tcp:3000` si API `http://127.0.0.1:3000`
- Shortcut development: token `test` (acceptat de backend doar in non-production)

## 5) Build/package pentru target

### Build workspace (Node apps)
```bash
corepack pnpm -r build
```

### Lint + test
```bash
corepack pnpm -r lint
corepack pnpm -r test
```

### Tizen package (`.wgt`)
1. Genereaza `.wgt` semnat:
```bash
corepack pnpm --filter @iptv/tizen package:wgt:signed -- --ProfileName <SIGN_PROFILE>
```
2. Sau `.wgt` nesemnat (doar pentru inspectie locala):
```bash
corepack pnpm --filter @iptv/tizen package:wgt:unsigned
```
Note:
- `apps/tizen/config.xml` este folosit la packaging.
- TV-urile retail Samsung nu instaleaza direct `.wgt` de pe USB.
- Pentru USB foloseste fluxul Seller Office: vezi `apps/tizen/USB-INSTALL.md`.

### webOS package/install (`.ipk`)
1. Package only:
```bash
corepack pnpm --filter @iptv/webos package:ipk
```
2. Build + package + install + launch pe TV:
```bash
corepack pnpm --filter @iptv/webos install:webos -Device <DEVICE_ALIAS>
```
3. Uninstall app de pe TV:
```bash
corepack pnpm --filter @iptv/webos uninstall:webos -Device <DEVICE_ALIAS>
```
Note:
- `apps/webos/public/appinfo.json` este inclus in package.
- Setup device alias se face cu `ares-setup-device`.
- Ghid detaliat: `apps/webos/DEVICE-INSTALL.md`.

### Android debug APK
```bash
cd apps/android-tv
gradle :app:assembleDebug
```
APK rezultat: `apps/android-tv/app/build/outputs/apk/debug/`

## 6) Flow MVP cap-coada

Nota UI:
- webOS, Tizen, MAG si Android folosesc acelasi flow de baza: `Menu -> Pairing/Token -> Player`.

1. User se inregistreaza/login in `web-admin`.
2. La inregistrare admin se trimite cod numeric de confirmare (8 cifre) pe email (Gmail SMTP), apoi user introduce codul in formular.
2.1 Daca admin uita parola, foloseste "forgot password" si primeste pe email link de reset.
2.2 Daca codul de confirmare a expirat, din ecranul de login se poate retrimite emailul de confirmare.
3. User seteaza URL pentru M3U ?i XMLTV.
4. Android app cere `POST /devices/pair/start` si afiseaza cod.
5. User confirma cod in `web-admin` (`POST /devices/pair/confirm`).
6. Android app face polling la `GET /devices/pair/status` pana primeste `deviceToken`.
7. Android app incarca:
- `GET /device/profile`
- `GET /device/playlist`
- `GET /device/epg/now-next`
8. User navigheaza remote-first, reda stream-ul ?i gestioneaza favorites locale.

## 7) Smoke test checklist

1. Backend porne?te ?i `/docs` raspunde 200.
2. Register + login reu?esc din web-admin.
3. `playlist/set-url` ?i `epg/set-url` raspund `success: true`.
4. Android app primeste cod pairing si pairing devine `PAIRED`.
5. Android app primeste canale din `/device/playlist`.
6. Cel pu?in un stream HLS porne?te in player.
7. `Now/Next` apare pentru canale cu mapping `tvg-id`.
8. Favorite toggling persista dupa restart app (storage local device/browser).
9. `POST /telemetry/event` inregistreaza evenimente in DB.

## 11) Catalog OTT (providers/channels/logo/EPG)

Backend-ul include acum sincronizare pentru `https://epg.ott-play.com` cu stocare in DB:
- provideri (tabelul principal)
- canale + logo + `tvg-id` + link EPG (tabelul pe provider)
- programe EPG pe canal (tabelul final)

Comportament curent:
- EPG pentru device-uri este luat **automat** din `epg.ott-play.com`.
- Playlist-ul este imbogatit automat cu `tvg-id` si logo din providerul cu cele mai bune potriviri (`OTT_DEFAULT_PROVIDER_KEY` + `OTT_FALLBACK_PROVIDER_KEYS`).
- Nu mai este necesar sa setezi manual URL EPG pentru fiecare utilizator.

Endpoint-uri (JWT admin):
- `GET /ott-catalog/stats`
- `GET /ott-catalog/providers`
- `POST /ott-catalog/providers/sync`
- `GET /ott-catalog/providers/:providerId/channels`
- `POST /ott-catalog/providers/:providerId/channels/sync`
- `GET /ott-catalog/channels/:channelId/programs`
- `POST /ott-catalog/channels/:channelId/programs/sync`
- `POST /ott-catalog/providers/:providerId/programs/sync`
- `POST /ott-catalog/sync/full`

Exemplu sync controlat (anti-supraincarcare):
```bash
curl -X POST http://localhost:3000/ott-catalog/sync/full \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d "{\"providerLimit\":8,\"channelsPerProvider\":20,\"delayMs\":250}"
```

Note:
- exista TTL/cache pentru sync automat (providers/channels/programs), ca sa nu faca fetch la fiecare request;
- sync-ul de programe ruleaza secvential cu delay configurabil (`delayMs`) ca sa evite load mare.

## 8) Considera?ii de securitate MVP

- JWT pentru user auth.
- Device token separat pentru endpoint-urile de device app.
- Rate limiting activ prin `@nestjs/throttler`.
- Validare DTO (`class-validator`) pe request-uri.
- URL sanitization + protocol allowlist `http/https`.
- SSRF mitigation de baza: blocare localhost/private/metadata ranges.

## 9) Limitari MVP ?i next steps

Limitari curente:
- Fara DRM/Widevine.
- Fara catch-up/recording/transcoding.
- Parsing EPG stocat ca JSON snapshot (fara motor avansat de indexare/time-shift).
- Pentru Android, scripturile pnpm doar indica taskurile Gradle; build-ul efectiv se face din Android Studio/Gradle.
- MAG Linux nu are in mod normal suport pentru APK; in acest repo suportul MAG este oferit prin web app (`apps/mag`).

Next steps recomandate:
- sesiuni refresh token + revoke
- observabilitate (OpenTelemetry + traces)
- indexare EPG in tabele dedicate pentru query performant
- suport DRM + ABR tuning per platforma
- testare e2e automata pe emulatoare Tizen/webOS/Android

## 10) Demo source policy

Nu sunt hardcodate stream-uri protejate/copyright.
Folose?te numai M3U/XMLTV furnizate legal de utilizator.
