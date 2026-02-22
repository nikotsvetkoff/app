@echo off
set VITE_API_BASE_URL=http://10.0.0.246:3000
corepack pnpm --filter @iptv/web-admin dev
