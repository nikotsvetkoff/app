# LG webOS Device Install

## Prerequisites

1. Install webOS CLI:
```powershell
npm i -g @webos-tools/cli
```
2. Enable `Developer Mode` on the LG TV and note the TV IP.
3. Pair the TV with CLI (example alias: `livingroom-tv`):
```powershell
ares-setup-device --add livingroom-tv --info "host=192.168.1.50,port=9922,username=prisoner"
```
4. Verify configured devices:
```powershell
ares-setup-device --list
```

## Build + Package + Install + Launch

From repo root:

```powershell
corepack pnpm --filter @iptv/webos install:webos -Device livingroom-tv
```

This command will:
- build `@iptv/webos` and dependencies,
- package an `.ipk` in `apps/webos/artifacts/`,
- install it on the selected TV,
- launch the app after install.

## Package Only

```powershell
corepack pnpm --filter @iptv/webos package:ipk
```

## Uninstall From TV

```powershell
corepack pnpm --filter @iptv/webos uninstall:webos -Device livingroom-tv
```

## Useful Flags

- `-SkipBuild`: use existing `apps/webos/dist`.
- `-SkipLaunch`: install without auto-launch.
- `-NoCleanup`: keep temporary `.ipk-staging` folder for debugging.
