# Changelog

Breaking changes and migration steps for existing deployments. Entries are newest-first.

When deploying to a VPS that was set up before a breaking change, follow the **Migration** steps for each entry between the deployed version and the current version.

---

## 2026-03-13 — Pinned bridge subnet + cloudflared networking

**BREAKING:** The `openclaw-net` Docker bridge subnet is now pinned to `10.200.0.0/24` (was auto-assigned, typically `172.x.0.0/24`). Cloudflared reverted from `network_mode: host` to bridge networking with a static IP (`10.200.0.100`). Tunnel ingress routes must use Docker DNS container names (not `localhost`).

**What changed:**
- `docker-compose.yml.hbs`: openclaw-net pinned to `10.200.0.0/24`, cloudflared on bridge with `ipv4_address: 10.200.0.100`
- `openclaw.jsonc` (all configs): `trustedProxies` changed to `["10.200.0.100"]`
- `cf-tunnel-setup.sh`: generates routes using Docker DNS names (e.g., `http://<project>-openclaw-<claw>:18789`) instead of `localhost`
- Cloudflared hardened: `cap_drop: [ALL]`, `no-new-privileges`, `read_only`

**Migration:**

1. Update `trustedProxies` in each claw's `openclaw.jsonc` (live on VPS or local per-claw config):
   ```jsonc
   "trustedProxies": ["10.200.0.100"]
   ```

2. Update Cloudflare tunnel ingress routes to use Docker DNS names instead of `localhost`. Either:
   - Run `scripts/cf-tunnel-setup.sh setup-routes` (requires `CF_API_TOKEN`), or
   - Manually update in Cloudflare Dashboard: change `http://localhost:<port>` to `http://<project>-openclaw-<claw>:<port>` for each route

3. Recreate containers (network subnet change requires `down` + `up`):
   ```bash
   sudo -u openclaw bash -c 'cd <INSTALL_DIR> && docker compose down && docker compose up -d'
   ```

**Verify:** `sudo docker network inspect openclaw_openclaw-net --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'` should return `10.200.0.0/24`. `sudo docker inspect <project>-cloudflared --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'` should return `10.200.0.100`.

---

## 2026-03-11 — Fix llmetry typo (59c276b)

**BREAKING:** Renamed `LLMTERY_*` env vars and config keys to `LLMETRY_*` (typo fix).

**Migration:** Update `.env` and `stack.yml` if you have the old `LLMTERY_` spelling. `npm run pre-deploy` will use the corrected names.
