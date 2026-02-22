## MAG app (Linux STB web runtime)

Aplicatia din `apps/mag` este varianta browser-based pentru boxuri MAG/Linux.

Flow UI este acelasi ca pe webOS/Tizen:
- `Menu`
- `Pair with QR + code`
- `Player` (split/fullscreen)

Pasi recomandati (client mode):
1. rulezi `Pair with code`
2. confirmi codul in dashboard-ul admin
3. intri in `Player`

Clientul nu vede date interne de Playlist/EPG.

### Run local

```bash
corepack pnpm --filter @iptv/mag dev
```

Default dev URL: `http://localhost:5176`

### Build

```bash
corepack pnpm --filter @iptv/mag build
```

### Lint

```bash
corepack pnpm --filter @iptv/mag lint
```

### Notes MAG

- Este web app, nu APK.
- Pe device real, setezi `Backend API URL` pe LAN (ex: `http://192.168.1.50:3000`).
- Suportul exact pentru codecuri depinde de browser-ul modelului MAG.

### MAG250 remote mapping

- `UP/DOWN/LEFT/RIGHT`: navigatie
- `OK/ENTER`: select/confirm
- `EXIT/BACK`: inapoi
- `MENU` (keycode 122/123): toggle lista canale in player
- `CH+ / CH-` (Tab / Shift+Tab): next/previous canal
