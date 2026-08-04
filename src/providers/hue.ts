import { ProviderError } from "./govee";
import type { LightCapability, LightCommand, LightDevice, LightProvider } from "./types";

export type HueBridgeConfig = {
  bridgeIp: string;
  username: string;
};

type HueLight = {
  name: string;
  state?: {
    on?: boolean;
    bri?: number;
    ct?: number;
    hue?: number;
    sat?: number;
    colormode?: string;
  };
  capabilities?: {
    control?: {
      colorgamut?: number[][];
      ct?: { min?: number; max?: number };
    };
  };
};

export class HueProvider implements LightProvider {
  readonly id = "hue";
  readonly name = "Philips Hue";
  private devices = new Map<string, HueLight>();
  private readonly baseUrl: string;

  constructor(private readonly config: HueBridgeConfig) {
    this.baseUrl = `http://${config.bridgeIp}/api/${config.username}`;
  }

  static async pair(bridgeIp: string): Promise<HueBridgeConfig> {
    const normalizedIp = normalizeBridgeIp(bridgeIp);
    const response = await fetch(`http://${normalizedIp}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ devicetype: "glow_control#bun" }),
    }).catch(() => {
      throw new ProviderError(`Could not reach the Hue Bridge at ${normalizedIp}`, 502);
    });
    const body = await response.json().catch(() => null) as Array<{ success?: { username?: string }; error?: { type?: number; description?: string } }> | null;
    const username = body?.[0]?.success?.username;
    if (!response.ok || !username) {
      const hueError = body?.[0]?.error;
      if (hueError?.type === 101) {
        throw new ProviderError("Press the round link button on the Hue Bridge, then click Pair bridge within 30 seconds", 409);
      }
      throw new ProviderError(hueError?.description ?? "Could not pair the Hue Bridge", 400);
    }
    return { bridgeIp: normalizedIp, username };
  }

  async listDevices(): Promise<LightDevice[]> {
    const response = await this.request<Record<string, HueLight>>("/lights");
    this.devices = new Map(Object.entries(response));
    return Object.entries(response).map(([id, light]) => ({
      id,
      provider: this.id,
      name: light.name,
      model: "Hue light",
      capabilities: capabilitiesFor(light),
    }));
  }

  async control(deviceId: string, command: LightCommand): Promise<void> {
    if (!this.devices.has(deviceId)) await this.listDevices();
    if (!this.devices.has(deviceId)) {
      throw new ProviderError(`Hue light ${deviceId} was not found`, 404);
    }

    let state: Record<string, unknown>;
    switch (command.type) {
      case "power":
        state = { on: command.on };
        break;
      case "brightness":
        state = { bri: Math.round((command.value / 100) * 254) };
        break;
      case "color":
        state = { xy: rgbToXy(command.red, command.green, command.blue) };
        break;
      case "temperature":
        state = { ct: Math.round(1_000_000 / command.value) };
        break;
    }
    await this.request(`/lights/${encodeURIComponent(deviceId)}/state`, {
      method: "PUT",
      body: JSON.stringify(state),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    }).catch(() => {
      throw new ProviderError("Could not reach the Hue Bridge", 502);
    });
    const body = await response.json().catch(() => null) as T | Array<{ error?: { description?: string } }> | null;
    if (!response.ok) {
      throw new ProviderError(`Hue API returned HTTP ${response.status}`, response.status);
    }
    if (Array.isArray(body) && body.some((item) => item.error)) {
      throw new ProviderError(body.find((item) => item.error)?.error?.description ?? "Hue API request failed", 400);
    }
    return body as T;
  }
}

function normalizeBridgeIp(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!trimmed || trimmed.includes("/") || trimmed.includes(" ")) {
    throw new ProviderError("Enter a valid Hue Bridge IP address or hostname", 400);
  }
  return trimmed;
}

function capabilitiesFor(light: HueLight): LightCapability[] {
  const capabilities: LightCapability[] = [
    { type: "devices.capabilities.on_off", instance: "powerSwitch" },
  ];
  if (light.state?.bri !== undefined) {
    capabilities.push({ type: "devices.capabilities.range", instance: "brightness" });
  }
  if (light.capabilities?.control?.colorgamut || light.state?.hue !== undefined) {
    capabilities.push({ type: "devices.capabilities.color_setting", instance: "colorRgb" });
  }
  if (light.capabilities?.control?.ct || light.state?.ct !== undefined) {
    capabilities.push({ type: "devices.capabilities.color_setting", instance: "colorTemperatureK" });
  }
  return capabilities;
}

function rgbToXy(red: number, green: number, blue: number): { x: number; y: number } {
  const [r, g, b] = [red, green, blue].map((value) => {
    const normalized = value / 255;
    return normalized > 0.04045
      ? ((normalized + 0.055) / 1.055) ** 2.4
      : normalized / 12.92;
  });
  const x = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const total = x + y + z;
  if (total === 0) return { x: 0.3227, y: 0.329 };
  return { x: Number((x / total).toFixed(4)), y: Number((y / total).toFixed(4)) };
}
