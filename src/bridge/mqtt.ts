import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { readFile } from "node:fs/promises";
import type { LightCommand, LightDevice } from "../providers/types";

type BridgeRule = {
  name?: string;
  topic: string;
  when?: Record<string, unknown>;
  commands: Array<{
    provider: string;
    deviceId: string;
    command: LightCommand;
  }>;
};

type BridgeRulesFile = { rules?: BridgeRule[] };

type MqttBridgeOptions = {
  url: string;
  username?: string;
  password?: string;
  topicPrefix: string;
  zigbeeTopic: string;
  rulesFile: string;
  listDevices: () => Promise<LightDevice[]>;
  control: (providerId: string, deviceId: string, command: LightCommand) => Promise<void>;
};

export async function loadBridgeRules(path: string): Promise<BridgeRule[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as BridgeRulesFile;
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

export class MqttBridge {
  private client?: MqttClient;
  private readonly lightIds = new Map<string, { provider: string; deviceId: string }>();

  constructor(private readonly options: MqttBridgeOptions) {}

  start(): void {
    const clientOptions: IClientOptions = {
      username: this.options.username,
      password: this.options.password,
      clientId: `glow-control-${crypto.randomUUID()}`,
      reconnectPeriod: 5_000,
    };
    this.client = mqtt.connect(this.options.url, clientOptions);
    this.client.on("connect", () => void this.handleConnect());
    this.client.on("error", (error) => console.error("MQTT bridge error:", error.message));
    this.client.on("message", (topic, payload) => void this.handleMessage(topic, payload));
  }

  async publishDevices(devices?: LightDevice[]): Promise<void> {
    if (!this.client?.connected) return;
    const currentDevices = devices ?? await this.options.listDevices();
    const activeIds = new Set<string>();

    for (const device of currentDevices) {
      const lightId = this.lightId(device);
      activeIds.add(lightId);
      this.lightIds.set(lightId, { provider: device.provider, deviceId: device.id });
      this.publish(`${this.options.topicPrefix}/lights/${lightId}/config`, {
        id: lightId,
        name: device.name,
        provider: device.provider,
        deviceId: device.id,
        model: device.model,
        capabilities: device.capabilities,
        commandTopic: `${this.options.topicPrefix}/lights/${lightId}/set`,
        stateTopic: `${this.options.topicPrefix}/lights/${lightId}/state`,
      }, true);
    }

    for (const lightId of this.lightIds.keys()) {
      if (!activeIds.has(lightId)) {
        this.client.publish(`${this.options.topicPrefix}/lights/${lightId}/config`, "", { retain: true });
        this.lightIds.delete(lightId);
      }
    }
  }

  private async handleConnect(): Promise<void> {
    if (!this.client) return;
    await new Promise<void>((resolve, reject) => {
      this.client?.subscribe([
        `${this.options.topicPrefix}/lights/+/set`,
        `${this.options.zigbeeTopic}/#`,
      ], (error) => error ? reject(error) : resolve());
    }).catch((error) => console.error("Could not subscribe to MQTT bridge topics:", error.message));

    this.publish(`${this.options.topicPrefix}/status`, { state: "online" }, true);
    try {
      await this.publishDevices();
    } catch (error) {
      console.error("Could not publish Govee lights to MQTT:", error);
    }
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      console.warn(`Ignoring non-JSON MQTT message on ${topic}`);
      return;
    }

    const lightMatch = topic.match(new RegExp(`^${escapeRegExp(this.options.topicPrefix)}/lights/([^/]+)/set$`));
    if (lightMatch) {
      await this.handleLightCommand(lightMatch[1], message);
      return;
    }

    if (topic.startsWith(`${this.options.zigbeeTopic}/`)) {
      await this.handleZigbeeEvent(topic, message);
    }
  }

  private async handleLightCommand(lightId: string, message: unknown): Promise<void> {
    const target = this.lightIds.get(lightId);
    if (!target || !isLightCommand(message)) {
      this.publish(`${this.options.topicPrefix}/lights/${lightId}/error`, { error: "Unknown light or invalid command" });
      return;
    }

    try {
      await this.options.control(target.provider, target.deviceId, message);
      this.publish(`${this.options.topicPrefix}/lights/${lightId}/state`, {
        state: message.type === "power" ? (message.on ? "ON" : "OFF") : "ON",
        ...message,
      }, true);
    } catch (error) {
      this.publish(`${this.options.topicPrefix}/lights/${lightId}/error`, {
        error: error instanceof Error ? error.message : "Light command failed",
      });
    }
  }

  private async handleZigbeeEvent(topic: string, message: unknown): Promise<void> {
    const rules = await loadBridgeRules(this.options.rulesFile);
    for (const rule of rules) {
      if (topic !== rule.topic || !matches(message, rule.when ?? {})) continue;
      for (const action of rule.commands) {
        try {
          await this.options.control(action.provider, action.deviceId, action.command);
        } catch (error) {
          console.error(`Bridge rule ${rule.name ?? topic} failed:`, error);
        }
      }
    }
  }

  private publish(topic: string, value: unknown, retain = false): void {
    this.client?.publish(topic, JSON.stringify(value), { retain });
  }

  private lightId(device: LightDevice): string {
    return `${device.provider}_${device.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  }
}

function matches(value: unknown, expected: Record<string, unknown>): boolean {
  if (!expected || Object.keys(expected).length === 0) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(expected).every(([key, expectedValue]) =>
    JSON.stringify((value as Record<string, unknown>)[key]) === JSON.stringify(expectedValue),
  );
}

function isLightCommand(value: unknown): value is LightCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (command.type === "power") return typeof command.on === "boolean";
  if (command.type === "brightness" || command.type === "temperature") {
    return typeof command.value === "number";
  }
  return command.type === "color" &&
    typeof command.red === "number" &&
    typeof command.green === "number" &&
    typeof command.blue === "number";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
