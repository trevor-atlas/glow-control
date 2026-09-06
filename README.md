# Glow control

A small Bun app for discovering and controlling Govee lights. The provider boundary is intentionally simple so Hue and Elgato adapters can be added without changing the UI or HTTP API.

## Run it

```bash
cd /Users/tatlas/src/govee-lights
cp .env.example .env.local
# Put your Govee developer API key in .env.local as GOVEE_API_KEY
bun run dev
```

Open <http://localhost:3000>.

The key stays server-side and is never sent to the browser. `.env.local` is ignored by git. If the key shared during setup is a real production key, rotate it if it has been exposed anywhere public.

## Current scope

- Discover Govee devices and their advertised capabilities.
- Pair an existing Philips Hue Bridge from the web UI and discover/control its lights over the local network.
- Save local device names that persist in `data/device-names.json` across restarts.
- Toggle power.
- Set brightness, RGB color, and color temperature when a device advertises those capabilities.
- Normalize provider/device/control routes so future Hue and Elgato providers can plug into the same UI.

Govee's cloud API has account and device rate limits. The app only refreshes devices on page load or when the refresh button is clicked; control requests go through the documented `/router/api/v1/device/control` endpoint.

## Optional Zigbee2MQTT bridge

The app can connect to an MQTT broker used by Zigbee2MQTT. This does not turn Govee hardware into Zigbee devices. Instead, it publishes a provider-neutral MQTT representation of each Govee light under `${MQTT_TOPIC_PREFIX}/lights/...` and listens for Zigbee2MQTT events under `${ZIGBEE2MQTT_BASE_TOPIC}/...`.

## UI architecture

The browser UI is React-rendered and uses a persistent WebSocket connection at `/ws` for device snapshots, controls, naming, and Hue setup. The older HTTP API remains available for compatibility. Run `bun run build:ui` after UI source changes, or use `bun run dev:ui` for a watched frontend build.

To enable it, set `MQTT_URL` in `.env.local`, then copy the example rules file:

```bash
cp data/bridge-rules.example.json data/bridge-rules.json
```

Each rule matches a Zigbee2MQTT topic and selected JSON fields, then sends normalized light commands through the configured provider. See `data/bridge-rules.example.json` for the shape.

## Deployment

glow runs as a Docker container managed by Coolify (app `glow-control:main`, raw Docker Compose mode). Pushing to `main` auto-deploys.

- `network_mode: host` is required: Elgato discovery browses mDNS (`_elg._tcp`), which does not cross a docker bridge.
- The container binds `172.17.0.1:3000` (the docker0 gateway) — Caddy and the rehearsal Traefik proxy reach it there. The old systemd unit (`glow-control.service`) is disabled; rollback = re-enable the unit and stop the container.
- Runtime state (`hue-bridge.json`, `device-*.json`, `elgato-lights.json`, `bridge-rules.json`) lives in `data/` on the host, bind-mounted to `/app/data`.
