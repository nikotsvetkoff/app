## Web Admin (PC web widget)

Dashboard-ul din `apps/web-admin` este punctul de administrare pentru:

1. `Account` - register/login.
2. `Surse` - setare URL playlist + EPG.
3. `Pairing TV` - confirmare cod pentru device.
4. `Status` - feedback pentru operatiile efectuate.

### Run local

```bash
corepack pnpm --filter @iptv/web-admin dev
```

Default dev URL: `http://localhost:5175`

### Build

```bash
corepack pnpm --filter @iptv/web-admin build
```

### Lint

```bash
corepack pnpm --filter @iptv/web-admin lint
```
