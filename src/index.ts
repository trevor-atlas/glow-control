import { mkdir, rename } from "node:fs/promises";
import { MqttBridge } from "./bridge/mqtt";
import { GoveeProvider, ProviderError } from "./providers/govee";
import { HueProvider, type HueBridgeConfig } from "./providers/hue";
import { discoverHueBridges } from "./providers/hue-discovery";
import { ElgatoProvider, type ElgatoLightConfig } from "./providers/elgato";
import { discoverElgatoLights } from "./providers/elgato-discovery";
import type { DeviceRef, Group, LightCommand, LightDevice, LightProvider, LightState } from "./providers/types";

type DeviceNames = Record<string, Record<string, string>>;
type DevicePalettes = Record<string, Record<string, string[]>>;

/** Persisted shape of a user-defined group (source of truth: groups.json). */
type StoredGroup = {
  id: string;
  name: string;
  members: DeviceRef[];
};

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
const groupsFile = `${dataDirectory}/groups.json`;
const providers = new Map<string, LightProvider>();
let deviceNames = await loadDeviceNames();
let devicePalettes = await loadDevicePalettes();
let hueConfig = await loadHueConfig();
let elgatoConfig = await loadElgatoLights();
let nameWriteQueue = Promise.resolve();
let paletteWriteQueue = Promise.resolve();
let elgatoWriteQueue = Promise.resolve();
let manualGroups = await loadManualGroups();
let groupsWriteQueue = Promise.resolve();

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

async function loadManualGroups(): Promise<StoredGroup[]> {
  const file = Bun.file(groupsFile);
  if (!(await file.exists())) return [];
  try {
    const parsed = await file.json();
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredGroup =>
        typeof entry?.id === "string" &&
        typeof entry?.name === "string" &&
        Array.isArray(entry?.members) &&
        entry.members.every(
          (member) =>
            typeof member === "object" &&
            member !== null &&
            typeof (member as DeviceRef).provider === "string" &&
            typeof (member as DeviceRef).id === "string",
        ),
    );
  } catch {
    console.warn(`Could not read ${groupsFile}; starting with no groups.`);
    return [];
  }
}

async function saveManualGroups(): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${groupsFile}.tmp`;
  await Bun.write(temporaryFile, `${JSON.stringify(manualGroups, null, 2)}\n`);
  await rename(temporaryFile, groupsFile);
}

function runGroupsMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = groupsWriteQueue.then(task, task);
  groupsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
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

// Cached state, keyed by `${providerId}:${deviceId}`. The cache is the
// source of truth for snapshots: providers that report live state (Hue,
// Elgato) win, and the cache is refreshed on connect / updated on every
// successful control.
const deviceStates = new Map<string, LightState>();
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
  const previous = deviceStates.get(key) ?? {};
  if (command.type === "power") {
    deviceStates.set(key, { ...previous, on: command.on });
  } else {
    // Any brightness/color/temperature change turns the light on.
    const update: LightState = { ...previous, on: true };
    if (command.type === "brightness") update.brightness = command.value;
    if (command.type === "color") update.color = { red: command.red, green: command.green, blue: command.blue };
    if (command.type === "temperature") update.temperature = command.value;
    deviceStates.set(key, update);
  }
}

/**
 * Derive an aggregated state for a group from its members' states. Any member
 * on means the group reads as on; brightness/temperature are the mean of the
 * members that report them.
 */
function deriveGroupState(members: DeviceRef[], devices: LightDevice[]): LightState | undefined {
  const states = members
    .map((member) =>
      devices.find((device) => device.provider === member.provider && device.id === member.id)?.state,
    )
    .filter((state): state is LightState => Boolean(state));
  if (!states.length) return undefined;

  const result: LightState = {};
  if (states.some((state) => state.on === true)) result.on = true;
  else if (states.every((state) => state.on === false)) result.on = false;

  const brightness = states
    .map((state) => state.brightness)
    .filter((value): value is number => value !== undefined);
  if (brightness.length) {
    result.brightness = Math.round(brightness.reduce((sum, value) => sum + value, 0) / brightness.length);
  }

  const temperature = states
    .map((state) => state.temperature)
    .filter((value): value is number => value !== undefined);
  if (temperature.length) {
    result.temperature = Math.round(temperature.reduce((sum, value) => sum + value, 0) / temperature.length);
  }

  return result;
}

/**
 * Every group the app knows about: provider-seeded groups (rooms, zones, …)
 * plus user-defined groups from groups.json. Manual group state is derived
 * from the member devices in `devices` (fetched when omitted).
 */
async function listGroups(devices?: LightDevice[]): Promise<Group[]> {
  const knownDevices = devices ?? await listDevices();
  const groups: Group[] = [];

  const providerResults = await Promise.allSettled(
    [...providers.values()].map(async (provider) => ({
      provider,
      groups: provider.listGroups ? await provider.listGroups() : [],
    })),
  );
  for (const result of providerResults) {
    if (result.status === "rejected") {
      console.error("Could not load groups from a provider:", result.reason);
      continue;
    }
    for (const group of result.value.groups) {
      groups.push({
        id: `${result.value.provider.id}:${group.id}`,
        name: group.name,
        source: "provider",
        providerId: result.value.provider.id,
        providerGroupId: group.id,
        members: group.members,
        state: group.state,
      });
    }
  }

  for (const group of manualGroups) {
    groups.push({
      id: group.id,
      name: group.name,
      source: "manual",
      members: group.members,
      state: deriveGroupState(group.members, knownDevices),
    });
  }

  return groups;
}

/** Resolve a group (manual or provider) down to its member device refs. */
async function resolveGroup(groupId: string): Promise<{ name: string; members: DeviceRef[] }> {
  const manual = manualGroups.find((group) => group.id === groupId);
  if (manual) return { name: manual.name, members: manual.members };

  for (const provider of providers.values()) {
    if (!provider.listGroups) continue;
    const groups = await provider.listGroups();
    const group = groups.find((entry) => `${provider.id}:${entry.id}` === groupId);
    if (group) return { name: group.name, members: group.members };
  }

  throw new ProviderError(`Group ${groupId} was not found`, 404);
}

/**
 * Control every device in a group. Provider groups are controlled the same
 * way as manual ones (fan out to members), so no provider-specific logic is
 * needed. Partial failures are reported without aborting the rest.
 */
async function controlGroup(groupId: string, command: LightCommand): Promise<void> {
  const group = await resolveGroup(groupId);
  const results = await Promise.allSettled(
    group.members.map((member) => controlDevice(member.provider, member.id, command)),
  );
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    const reason = failed[0].reason;
    throw new ProviderError(
      `Updated ${results.length - failed.length} of ${results.length} lights in “${group.name}”` +
        (reason instanceof Error ? `: ${reason.message}` : ""),
      502,
    );
  }
}

/** Validate and normalize a members array from a request body. */
function deviceRefsFrom(value: unknown): DeviceRef[] {
  if (!Array.isArray(value)) {
    throw new ProviderError("members must be an array of { provider, id }", 400);
  }
  const refs = value.filter(
    (entry): entry is DeviceRef =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as DeviceRef).provider === "string" &&
      typeof (entry as DeviceRef).id === "string",
  );
  if (refs.length !== value.length) {
    throw new ProviderError("Each group member needs a provider and device id", 400);
  }
  return refs;
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
  members?: DeviceRef[];
  command?: Record<string, unknown>;
};

type AppSocket = ServerWebSocket<unknown>;
const sockets = new Set<AppSocket>();

function sendSocket(socket: AppSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

async function buildSnapshotPayload(): Promise<Record<string, unknown>> {
  const devices = await listDevices();
  return {
    type: "snapshot",
    devices,
    groups: await listGroups(devices),
    configuredProviders: [...providers.keys()],
    hueConfigured: Boolean(hueConfig),
    hueBridgeIp: hueConfig?.bridgeIp ?? null,
    elgatoLights: elgatoConfig,
  };
}

async function sendSnapshot(socket: AppSocket): Promise<void> {
  sendSocket(socket, await buildSnapshotPayload());
}

async function broadcastSnapshot(): Promise<void> {
  if (!sockets.size) return;
  const message = JSON.stringify(await buildSnapshotPayload());
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
      case "create-group": {
        if (typeof message.name !== "string") throw new ProviderError("A group name is required", 400);
        const name = message.name.trim();
        if (!name) throw new ProviderError("A group name is required", 400);
        if (name.length > 80) throw new ProviderError("Group names must be 80 characters or fewer", 400);
        const members = deviceRefsFrom(message.members);
        await runGroupsMutation(async () => {
          manualGroups = [...manualGroups, { id: crypto.randomUUID(), name, members }];
          await saveManualGroups();
        });
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: `Created group “${name}”` });
        await broadcastSnapshot();
        return;
      }
      case "update-group": {
        if (typeof message.id !== "string") throw new ProviderError("A group id is required", 400);
        await runGroupsMutation(async () => {
          const existing = manualGroups.find((group) => group.id === message.id);
          if (!existing) throw new ProviderError(`Group ${message.id} was not found`, 404);
          const name = typeof message.name === "string" ? message.name.trim() : existing.name;
          if (!name) throw new ProviderError("A group name is required", 400);
          if (name.length > 80) throw new ProviderError("Group names must be 80 characters or fewer", 400);
          const members = message.members !== undefined ? deviceRefsFrom(message.members) : existing.members;
          manualGroups = manualGroups.map((group) => (group.id === message.id ? { ...group, name, members } : group));
          await saveManualGroups();
        });
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: "Group updated" });
        await broadcastSnapshot();
        return;
      }
      case "delete-group": {
        if (typeof message.id !== "string") throw new ProviderError("A group id is required", 400);
        await runGroupsMutation(async () => {
          const removed = manualGroups.find((group) => group.id === message.id);
          if (!removed) throw new ProviderError(`Group ${message.id} was not found`, 404);
          manualGroups = manualGroups.filter((group) => group.id !== message.id);
          await saveManualGroups();
        });
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: "Group deleted" });
        await broadcastSnapshot();
        return;
      }
      case "control-group": {
        if (typeof message.id !== "string") throw new ProviderError("A group id is required", 400);
        await controlGroup(message.id, commandFrom(message.command ?? {}));
        sendSocket(socket, { type: "ack", requestId: message.requestId, message: "Updated" });
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

  if (url.pathname === "/api/groups" && request.method === "GET") {
    return json({ groups: await listGroups() });
  }

  if (url.pathname === "/api/groups" && request.method === "POST") {
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new ProviderError("A group name is required", 400);
    if (name.length > 80) throw new ProviderError("Group names must be 80 characters or fewer", 400);
    const members = deviceRefsFrom(body.members);
    await runGroupsMutation(async () => {
      manualGroups = [...manualGroups, { id: crypto.randomUUID(), name, members }];
      await saveManualGroups();
    });
    void broadcastSnapshot();
    return json({ groups: await listGroups() });
  }

  const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupMatch && request.method === "PUT") {
    const groupId = decodeURIComponent(groupMatch[1]);
    const body = await readJson(request);
    await runGroupsMutation(async () => {
      const existing = manualGroups.find((group) => group.id === groupId);
      if (!existing) throw new ProviderError(`Group ${groupId} was not found`, 404);
      const name = typeof body.name === "string" ? body.name.trim() : existing.name;
      if (!name) throw new ProviderError("A group name is required", 400);
      if (name.length > 80) throw new ProviderError("Group names must be 80 characters or fewer", 400);
      const members = body.members !== undefined ? deviceRefsFrom(body.members) : existing.members;
      manualGroups = manualGroups.map((group) => (group.id === groupId ? { ...group, name, members } : group));
      await saveManualGroups();
    });
    void broadcastSnapshot();
    return json({ groups: await listGroups() });
  }

  if (groupMatch && request.method === "DELETE") {
    const groupId = decodeURIComponent(groupMatch[1]);
    await runGroupsMutation(async () => {
      const removed = manualGroups.find((group) => group.id === groupId);
      if (!removed) throw new ProviderError(`Group ${groupId} was not found`, 404);
      manualGroups = manualGroups.filter((group) => group.id !== groupId);
      await saveManualGroups();
    });
    void broadcastSnapshot();
    return json({ groups: await listGroups() });
  }

  const groupControlMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/control$/);
  if (groupControlMatch && request.method === "POST") {
    const groupId = decodeURIComponent(groupControlMatch[1]);
    const command = commandFrom(await readJson(request));
    await controlGroup(groupId, command);
    void broadcastSnapshot();
    return json({ ok: true });
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
  // Bind address; loopback by default, Tailscale Serve terminates TLS for tailnet access.
  hostname: Bun.env.HOST ?? "127.0.0.1",
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
