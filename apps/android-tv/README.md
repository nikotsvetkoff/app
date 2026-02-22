## Android app (TV + mobile + Android x86)

Aplicatia din `apps/android-tv` este acum pregatita pentru:
- Android TV / Google TV
- Android phone / tablet
- Android box / stick
- Android x86 (PC-uri cu Android)

### Build

Din Android Studio sau din terminal:

```bash
gradle :app:assembleDebug
gradle :app:assembleRelease
```

### Lint

```bash
gradle :app:ktlintCheck
```

### Flow UI (aliniat cu webOS)

Aplicatia urmeaza flow client simplificat:
- `Menu`: `Pair with code`
- `Player`: split/fullscreen cu lista de canale pe categorii

Acest flow este acum comun pentru webOS, Tizen, MAG si Android.
Playlist-ul Android foloseste acelasi model ca webOS: categorii + fereastra vizibila de canale.
In lista: UP/DOWN schimba selectia, ENTER porneste canalul selectat, iar in fullscreen UP/DOWN schimba canalul curent.

Pasi recomandati:
1. rulezi `Pair with code`
2. confirmi codul in dashboard-ul admin
3. intri in `Player`

Clientul nu vede date interne de Playlist/EPG.

### Note dezvoltare

Configurarea backend-ului si datele de sursa se gestioneaza in dashboard-ul admin.

### Input suportat

- Telecomanda/D-pad: Up/Down/Enter/Menu
- Touch: tap pe canal + buton `Fav` / `+Fav`

### MAG Linux

MAG nu este Android. In majoritatea cazurilor nu permite instalare APK nativ.
Pentru MAG, abordarea realista este:
- portal Stalker/Ministra compatibil MAG, sau
- web app optimizata pentru browser-ul boxului (daca modelul permite).
