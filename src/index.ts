import { mkdir, rename } from "node:fs/promises";
import { MqttBridge } from "./bridge/mqtt";
import { GoveeProvider, ProviderError } from "./providers/govee";
import { HueProvider, type HueBridgeConfig } from "./providers/hue";
import { discoverHueBridges } from "./providers/hue-discovery";
import { ElgatoProvider, type ElgatoLightConfig } from "./providers/elgato";
import { discoverElgatoLights } from "./providers/elgato-discovery";
import type { LightCommand, LightDevice, LightProvider } from "./providers/types";

type DeviceNames = Record<string, Record<string, string>>;
type DevicePalettes = Record<string, Record<string, string[]>>;

const DEFAULT_PALETTE = ["#ffffff", "#ff9500", "#ff3b30", "#34c759", "#007aff"];
const MAX_PALETTE_SIZE = 12;
const hexColorPattern = /^#[0-9a-f]{6}$/;

const port = Number(Bun.env.PORT ?? 3000);
const publicDirectory = `${import.meta.dir}/../dist`;
const dataDirectory = `${import.meta.dir}/../data`;
const deviceNamesFile = `${dataDirectory}/device-names.json`;
const devicePalettesFile = `${dataDirectory}/device-palettes.json`;
const hueConfigFile = `${dataDirectory}/hue-bridge.json`;
const elgatoLightsFile = `${dataDirectory}/elgato-lights.json`;
const providers = new Map<string, LightProvider>();
let deviceNames = await loadDeviceNames();
let devicePalettes = await loadDevicePalettes();
let hueConfig = await loadHueConfig();
let elgatoConfig = await loadElgatoLights();
let nameWriteQueue = Promise.resolve();
let paletteWriteQueue = Promise.resolve();
let elgatoWriteQueue = Promise.resolve();

if (Bun.env.GOVEE_API_KEY && Bun.env.GOVEE_API_KEY !== "replace-me") {
  providers.set("govee", new GoveeProvider(Bun.env.GOVEE_API_KEY));
}
if (hueConfig) {
  providers.set("hue", new HueProvider(hueConfig));
}
if (elgatoConfig.length) {
  providers.set("elgato", new ElgatoProvider(elgatoConfig));
}

const mqttBridge = Bun.env.MQTT_URL
  ? new MqttBridge({
      url: Bun.env.MQTT_URL,
      username: Bun.env.MQTT_USERNAME,
      password: Bun.env.MQTT_PASSWORD,
      topicPrefix: Bun.env.MQTT_TOPIC_PREFIX ?? "glow-control",
      zigbeeTopic: Bun.env.ZIGBEE2MQTT_BASE_TOPIC ?? "zigbee2mqtt",
      rulesFile: Bun.env.BRIDGE_RULES_FILE ?? `${dataDirectory}/bridge-rules.json`,
      listDevices,
      control: controlDevice,
    })
  : undefined;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function loadHueConfig(): Promise<HueBridgeConfig | undefined> {
  const file = Bun.file(hueConfigFile);
  if (!(await file.exists())) return undefined;
  try {
    const parsed = await file.json();
    if (typeof parsed?.bridgeIp === "string" && typeof parsed?.username === "string") {
      return parsed as HueBridgeConfig;
    }
  } catch {
    console.warn(`Could not read ${hueConfigFile}; Hue is not configured.`);
  }
  return undefined;
}

async function saveHueConfig(config: HueBridgeConfig): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${hueConfigFile}.tmp`;
  await Bun.write(temporaryFile, `${JSON.stringify(config, null, 2)}\n`);
  await rename(temporaryFile, hueConfigFile);
}

async function loadElgatoLights(): Promise<ElgatoLightConfig[]> {
  const file = Bun.file(elgatoLightsFile);
  if (!(await file.exists())) return [];
  try {
    const parsed = await file.json();
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ElgatoLightConfig =>
        typeof entry?.id === "string" && typeof entry?.ip === "string",
    );
  } catch {
    console.warn(`Could not read ${elgatoLightsFile}; Elgato lights are not configured.`);
    return [];
  }
}

async function saveElgatoLights(): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${elgatoLightsFile}.tmp`;
  await Bun.write(temporaryFile, `${JSON.stringify(elgatoConfig, null, 2)}\n`);
  await rename(temporaryFile, elgatoLightsFile);
}

function syncElgatoProvider(): void {
  if (elgatoConfig.length) providers.set("elgato", new ElgatoProvider(elgatoConfig));
  else providers.delete("elgato");
}

async function loadDeviceNames(): Promise<DeviceNames> {
  const file = Bun.file(deviceNamesFile);
  if (!(await file.exists())) return {};

  try {
    const parsed = await file.json();
    return parsed && typeof parsed === "object" ? parsed as DeviceNames : {};
  } catch {
    console.warn(`Could not read ${deviceNamesFile}; starting with no custom names.`);
    return {};
  }
}

async function saveDeviceName(providerId: string, deviceId: string, name: string): Promise<void> {
  const providerNames = { ...(deviceNames[providerId] ?? {}) };
  if (name) providerNames[deviceId] = name;
  else delete providerNames[deviceId];

  deviceNames = { ...deviceNames, [providerId]: providerNames };
  nameWriteQueue = nameWriteQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${deviceNamesFile}.tmp`;
    await Bun.write(temporaryFile, `${JSON.stringify(deviceNames, null, 2)}\n`);
    await rename(temporaryFile, deviceNamesFile);
  });
  await nameWriteQueue;
}

async function loadDevicePalettes(): Promise<DevicePalettes> {
  const file = Bun.file(devicePalettesFile);
  if (!(await file.exists())) return {};

  try {
    const parsed = await file.json();
    return parsed && typeof parsed === "object" ? parsed as DevicePalettes : {};
  } catch {
    console.warn(`Could not read ${devicePalettesFile}; starting with default palettes.`);
    return {};
  }
}

async function savePalette(providerId: string, deviceId: string, colors: string[]): Promise<void> {
  const providerPalettes = { ...(devicePalettes[providerId] ?? {}) };
  providerPalettes[deviceId] = colors;

  devicePalettes = { ...devicePalettes, [providerId]: providerPalettes };
  paletteWriteQueue = paletteWriteQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${devicePalettesFile}.tmp`;
    await Bun.write(temporaryFile, `${JSON.stringify(devicePalettes, null, 2)}\n`);
    await rename(temporaryFile, devicePalettesFile);
  });
  await paletteWriteQueue;
}

// Devices without a stored palette fall back to the defaults; an explicit empty
// array is kept so removing every color stays removed.
function paletteFor(providerId: string, deviceId: string): string[] {
  return devicePalettes[providerId]?.[deviceId] ?? DEFAULT_PALETTE;
}

async function addPaletteColor(providerId: string, deviceId: string, rawColor: string): Promise<boolean> {
  return runPaletteMutation(async () => {
    const color = rawColor.toLowerCase();
    if (!hexColorPattern.test(color)) {
      throw new ProviderError("Colors must be hex values like #ff9500", 400);
    }
    const palette = paletteFor(providerId, deviceId);
    if (palette.includes(color)) return false;
    if (palette.length >= MAX_PALETTE_SIZE) {
      throw new ProviderError(`Palettes can hold up to ${MAX_PALETTE_SIZE} colors`, 400);
    }
    await savePalette(providerId, deviceId, [...palette, color]);
    return true;
  });
}

async function removePaletteColor(providerId: string, deviceId: string, rawColor: string): Promise<boolean> {
  return runPaletteMutation(async () => {
    const color = rawColor.toLowerCase();
    if (!hexColorPattern.test(color)) {
      throw new ProviderError("Colors must be hex values like #ff9500", 400);
    }
    const palette = paletteFor(providerId, deviceId);
    if (!palette.includes(color)) return false;
    await savePalette(providerId, deviceId, palette.filter((entry) => entry !== color));
    return true;
  });
}

// Palette mutations are read-modify-write on shared state, so they are
// serialized to prevent concurrent adds/removes from overwriting each other.
let paletteMutationQueue = Promise.resolve();

function runPaletteMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = paletteMutationQueue.then(task, task);
  paletteMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function runElgatoMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = elgatoWriteQueue.then(task, task);
  elgatoWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

// Cached on/off state, keyed by `${providerId}:${deviceId}`. The cache is the
// source of truth for snapshots: providers that report live state (Hue) win,
// and the cache is refreshed on connect / updated on every successful control.
const deviceStates = new Map<string, { on?: boolean }>();
let lastStateRefresh = 0;
const STATE_REFRESH_MS = 30_000;

function deviceKey(providerId: string, deviceId: string): string {
  return `${providerId}:${deviceId}`;
}

type AppDevice = LightDevice & { customName: string; palette: string[] };

function withCustomNames(devices: LightDevice[]): AppDevice[] {
  return devices.map((device) => ({
    ...device,
    name: deviceNames[device.provider]?.[device.id] ?? device.name,
    customName: deviceNames[device.provider]?.[device.id] ?? "",
  }));
}

function withPalettes(devices: AppDevice[]): AppDevice[] {
  return devices.map((device) => ({
    ...device,
    palette: [...paletteFor(device.provider, device.id)],
  }));
}

function withStates(devices: AppDevice[]): AppDevice[] {
  return devices.map((device) => ({
    ...device,
    state: device.state ?? deviceStates.get(deviceKey(device.provider, device.id)),
  }));
}

async function listDevices(): Promise<AppDevice[]> {
  const results = await Promise.allSettled(
    [...providers.values()].map(async (provider) => ({ provider, devices: await provider.listDevices() })),
  );
  const devices: LightDevice[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      devices.push(...result.value.devices);
    } else {
      console.error("Could not load a light provider:", result.reason);
    }
  }
  return withStates(withPalettes(withCustomNames(devices)));
}

// Poll each provider that supports getState (Govee) once per STATE_REFRESH_MS
// window. Hue devices carry live state on every listDevices and are skipped.
async function refreshDeviceStates(): Promise<void> {
  const now = Date.now();
  if (now - lastStateRefresh < STATE_REFRESH_MS) return;
  lastStateRefresh = now;
  const devices = await listDevices();
  for (const device of devices) {
    if (device.state) continue;
    const provider = providers.get(device.provider);
    if (!provider?.getState) continue;
    const state = await provider.getState(device.id).catch(() => null);
    if (state) deviceStates.set(deviceKey(device.provider, device.id), state);
  }
}

async function controlDevice(providerId: string, deviceId: string, command: LightCommand): Promise<void> {
  const provider = providers.get(providerId);
  if (!provider) throw new ProviderError(`Provider ${providerId} is not configured`, 404);
  await provider.control(deviceId, command);
  const key = deviceKey(providerId, deviceId);
  if (command.type === "power") {
    deviceStates.set(key, { on: command.on });
  } else {
    // Any brightness/color/temperature change turns the light on.
    deviceStates.set(key, { ...deviceStates.get(key), on: true });
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Body must be an object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new ProviderError("Request body must be valid JSON", 400);
  }
}

function commandFrom(body: Record<string, unknown>): LightCommand {
  const type = body.type;
  if (type === "power" && typeof body.on === "boolean") {
    return { type, on: body.on };
  }
  if (type === "brightness" && typeof body.value === "number") {
    return { type, value: clamp(body.value, 1, 100) };
  }
  if (
    type === "color" &&
    typeof body.red === "number" &&
    typeof body.green === "number" &&
    typeof body.blue === "number"
  ) {
    return {
      type,
      red: clamp(body.red, 0, 255),
      green: clamp(body.green, 0, 255),
      blue: clamp(body.blue, 0, 255),
    };
  }
  if (type === "temperature" && typeof body.value === "number") {
    return { type, value: clamp(body.value, 2_000, 9_000) };
  }
  throw new ProviderError("Unsupported light command", 400);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new ProviderError("Command values must be finite numbers", 400);
  }
  return Math.round(Math.min(max, Math.max(min, value)));
}

type SocketMessage = {
  type?: string;
  requestId?: string;
  providerId?: string;
  deviceId?: string;
  bridgeIp?: string;
  ip?: string;
  id?: string;
  name?: string;
  color?: string;
  command?: Record<string, unknown>;
};

type AppSocket = ServerWebSocket<unknown>;
const sockets = new Set<AppSocket>();

function sendSocket(socket: AppSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

async function sendSnapshot(socket: AppSocket): Promise<void> {
  sendSocket(socket, {
    type: "snapshot",
    devices: await listDevices(),
    configuredProviders: [...providers.keys()],
    hueConfigured: Boolean(hueConfig),
    hueBridgeIp: hueConfig?.bridgeIp ?? null,
    elgatoLights: elgatoConfig,
  });
}

async function broadcastSnapshot(): Promise<void> {
  if (!sockets.size) return;
  const devices = await listDevices();
  const message = JSON.stringify({
    type: "snapshot",
    devices,
    configuredProviders: [...providers.keys()],
    hueConfigured: Boolean(hueConfig),
    hueBridgeIp: hueConfig?.bridgeIp ?? null,
    elgatoLights: elgatoConfig,
  });
  for (const socket of sockets) socket.send(message);
}

async function handleSocketMessage(socket: AppSocket, rawMessage: string | Buffer): Promise<void> {
  let message: SocketMessage;
  try {
    const parsed = JSON.parse(rawMessage.toString());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    message = parsed as SocketMessage;
  } catch {
    sendSocket(socket, { type: "error", error: "WebSocket messages must be valid JSON objects" });
    return;
  }

  try {
    switch (message.type) {
      case "refresh":
        await sendSnapshot(socket);
        return;
      case "control": {
        if (typeof message.providerId !== "string" || typeof message.deviceId !== "string") {
          throw new ProviderError("A provider and device are required", 400);
        }
        await controlDevice(message.providerId, message.deviceId, commandFrom(message.command ?? {}));
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: "Updated" });
        await broadcastSnapshot();
        return;
      }
      case "save-name": {
        if (typeof message.providerId !== "string" || typeof message.deviceId !== "string" || typeof message.name !== "string") {
          throw new ProviderError("A provider, device, and name are required", 400);
        }
        const name = message.name.trim();
        if (name.length > 80) throw new ProviderError("Device names must be 80 characters or fewer", 400);
        await saveDeviceName(message.providerId, message.deviceId, name);
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: name ? "Name saved" : "Custom name removed" });
        await broadcastSnapshot();
        return;
      }
      case "add-palette-color": {
        if (typeof message.providerId !== "string" || typeof message.deviceId !== "string" || typeof message.color !== "string") {
          throw new ProviderError("A provider, device, and color are required", 400);
        }
        const added = await addPaletteColor(message.providerId, message.deviceId, message.color);
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: added ? "Color added to presets" : "Color already in presets" });
        await broadcastSnapshot();
        return;
      }
      case "remove-palette-color": {
        if (typeof message.providerId !== "string" || typeof message.deviceId !== "string" || typeof message.color !== "string") {
          throw new ProviderError("A provider, device, and color are required", 400);
        }
        const removed = await removePaletteColor(message.providerId, message.deviceId, message.color);
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: removed ? "Color removed from presets" : "Color not in presets" });
        await broadcastSnapshot();
        return;
      }
      case "discover-hue":
        sendSocket(socket, { type: "hue-discovery", bridges: await discoverHueBridges() });
        return;
      case "pair-hue": {
        if (typeof message.bridgeIp !== "string") throw new ProviderError("A Hue Bridge IP address is required", 400);
        const config = await HueProvider.pair(message.bridgeIp);
        await saveHueConfig(config);
        hueConfig = config;
        providers.set("hue", new HueProvider(config));
        sendSocket(socket, { type: "hue-paired", bridgeIp: config.bridgeIp, requestId: message.requestId });
        await broadcastSnapshot();
        void mqttBridge?.publishDevices();
        return;
      }
      case "discover-elgato":
        sendSocket(socket, { type: "elgato-discovery", lights: await discoverElgatoLights() });
        return;
      case "add-elgato-light": {
        if (typeof message.ip !== "string") throw new ProviderError("An Elgato light IP address is required", 400);
        await runElgatoMutation(async () => {
          const light = await ElgatoProvider.discoverAt(message.ip);
          if (elgatoConfig.some((entry) => entry.id === light.id)) {
            sendSocket(socket, { type: "ack", message: `${light.name} is already added`, requestId: message.requestId });
            return;
          }
          elgatoConfig = [...elgatoConfig, light];
          await saveElgatoLights();
          syncElgatoProvider();
          await broadcastSnapshot();
          void mqttBridge?.publishDevices();
          sendSocket(socket, { type: "ack", message: `Added ${light.name}`, requestId: message.requestId });
        });
        return;
      }
      case "remove-elgato-light": {
        if (typeof message.id !== "string") throw new ProviderError("An Elgato light id is required", 400);
        await runElgatoMutation(async () => {
          const removed = elgatoConfig.find((entry) => entry.id === message.id);
          elgatoConfig = elgatoConfig.filter((entry) => entry.id !== message.id);
          await saveElgatoLights();
          syncElgatoProvider();
          await broadcastSnapshot();
          void mqttBridge?.publishDevices();
          sendSocket(socket, { type: "ack", message: removed ? `Removed ${removed.name ?? "Elgato light"}` : "Elgato light removed", requestId: message.requestId });
        });
        return;
      }
      case "flash-elgato-light": {
        if (typeof message.id !== "string") throw new ProviderError("An Elgato light id is required", 400);
        const light = elgatoConfig.find((entry) => entry.id === message.id);
        if (!light) throw new ProviderError("Elgato light not found", 404);
        await ElgatoProvider.flash(light);
        sendSocket(socket, { type: "ack", message: "Flashing light — check which one blinks", requestId: message.requestId });
        return;
      }
      default:
        throw new ProviderError(`Unsupported WebSocket message: ${message.type ?? "unknown"}`, 400);
    }
  } catch (error) {
    sendSocket(socket, {
      type: "error",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : "Request failed",
    });
    // Broadcast so clients revert their optimistic UI to the cached truth.
    if (message.type === "control") void broadcastSnapshot();
  }
}

async function api(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, configuredProviders: [...providers.keys()] });
  }

  if (url.pathname === "/api/hue/discover" && request.method === "GET") {
    return json(await discoverHueBridges());
  }

  if (url.pathname === "/api/hue/status" && request.method === "GET") {
    return json({ configured: Boolean(hueConfig), bridgeIp: hueConfig?.bridgeIp });
  }

  if (url.pathname === "/api/hue/pair" && request.method === "POST") {
    const body = await readJson(request);
    if (typeof body.bridgeIp !== "string") {
      throw new ProviderError("A Hue Bridge IP address is required", 400);
    }
    const config = await HueProvider.pair(body.bridgeIp);
    await saveHueConfig(config);
    hueConfig = config;
    providers.set("hue", new HueProvider(config));
    void mqttBridge?.publishDevices();
    void broadcastSnapshot();
    return json({ configured: true, bridgeIp: config.bridgeIp });
  }

  if (url.pathname === "/api/devices" && request.method === "GET") {
    const devices = await listDevices();
    void mqttBridge?.publishDevices(devices);
    return json({ devices });
  }

  const nameMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/devices\/([^/]+)\/name$/);
  if (nameMatch && request.method === "PUT") {
    const [, providerId, encodedDeviceId] = nameMatch;
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length > 80) {
      throw new ProviderError("Device names must be 80 characters or fewer", 400);
    }
    await saveDeviceName(providerId, decodeURIComponent(encodedDeviceId), name);
    void mqttBridge?.publishDevices();
    void broadcastSnapshot();
    return json({ ok: true, name });
  }

  const match = url.pathname.match(/^\/api\/providers\/([^/]+)\/devices\/([^/]+)\/control$/);
  if (match && request.method === "POST") {
    const [, providerId, deviceId] = match;
    const command = commandFrom(await readJson(request));
    await controlDevice(providerId, decodeURIComponent(deviceId), command);
    void broadcastSnapshot();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function staticFile(pathname: string): Promise<Response> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = requested.replace(/^\/+/, "").replaceAll("..", "");
  const file = Bun.file(`${publicDirectory}/${safePath}`);
  if (await file.exists()) return new Response(file);
  const fallback = Bun.file(`${publicDirectory}/index.html`);
  if (await fallback.exists()) return new Response(fallback);
  return new Response("Frontend not built — run `bun run build:web` or use `bun run dev` (Vite on :5173)", { status: 503 });
}

const server = Bun.serve({
  port,
  websocket: {
    open(socket) {
      sockets.add(socket);
      void (async () => {
        await refreshDeviceStates();
        await sendSnapshot(socket);
      })();
    },
    message(socket, message) {
      void handleSocketMessage(socket, message);
    },
    close(socket) {
      sockets.delete(socket);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/api/")) return await api(request, url);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return staticFile(url.pathname);
    } catch (error) {
      if (error instanceof ProviderError) {
        return json({ error: error.message }, error.status);
      }
      console.error(error);
      return json({ error: "Unexpected server error" }, 500);
    }
  },
});

console.log(`Light control app running at ${server.url}`);
if (mqttBridge) {
  mqttBridge.start();
  console.log("MQTT bridge enabled");
}
if (!providers.size) {
  console.warn("GOVEE_API_KEY is not configured; copy .env.example to .env.local and add it.");
}
