# Tizen USB Install Guide

## Important
Samsung retail Tizen TVs do not install `.wgt` apps directly from USB.
For USB install you need Samsung TV Seller Office `USB Demo Packaging Tool` output (`.tmg` + license bundle).

## Step 1: Build package from this repo

From repo root:

```powershell
corepack pnpm --filter @iptv/tizen package:wgt:signed -- --ProfileName <YOUR_TIZEN_CERT_PROFILE>
```

Signed artifact is generated in:
- `apps/tizen/artifacts/*.wgt`

If you only need a local unsigned archive:

```powershell
corepack pnpm --filter @iptv/tizen package:wgt:unsigned
```

Unsigned `.wgt` is not installable on retail TVs.

## Step 2: Create USB installable package

1. Log in to Samsung TV Seller Office.
2. Open `USB Demo Packaging Tool`.
3. Upload your signed `.wgt` from `apps/tizen/artifacts/`.
4. Generate USB demo package.
5. Copy generated files to USB exactly as instructed by Seller Office output.

## Step 3: Test on TV

1. Insert USB into TV.
2. Follow TV prompt / demo install flow (depends on TV model and firmware).

## Alternative for development testing (faster)
Use TV Developer Mode + network install with Tizen Studio Device Manager / `sdb install`.