## Tizen app (Samsung TV)

Aplicatia din `apps/tizen` foloseste flow client simplificat:

1. `Pair with code` pe player.
2. confirmi codul in dashboard-ul admin.
3. player-ul intra direct in canale.

Clientul nu vede setarile de playlist/EPG.

### Run local

```bash
corepack pnpm --filter @iptv/tizen dev
```

Default dev URL: `http://localhost:5173`

### Build

```bash
corepack pnpm --filter @iptv/tizen build
```

### Lint

```bash
corepack pnpm --filter @iptv/tizen lint
```
