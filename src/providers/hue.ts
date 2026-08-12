import { ProviderError } from "./govee";
import { clamp, hsToRgb, rgbToHs } from "./color";
import type { LightCapability, LightCommand, LightDevice, LightProvider, LightState, ProviderGroup } from "./types";

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
    /** CIE xy as [x, y] — the bridge reports an array, not an object. */
    xy?: [number, number];
    colormode?: string;
  };
  capabilities?: {
    control?: {
      colorgamut?: number[][];
      ct?: { min?: number; max?: number };
    };
  };
};

type HueGroup = {
  name: string;
  /** Room, Zone, Entertainment, Luminaire or LightGroup. */
  type: string;
  class?: string;
  lights: string[];
  /** Last command state, same shape as a light's state. */
  action?: HueLight["state"];
  state?: { all_on: boolean; any_on: boolean };
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
      state: stateFor(light.state),
    }));
  }

  async listGroups(): Promise<ProviderGroup[]> {
    const response = await this.request<Record<string, HueGroup>>("/groups");
    return Object.entries(response)
      // Entertainment areas, luminaires and ad-hoc light groups are not rooms;
      // keep only the real rooms and zones a user would think of as groups.
      .filter(([, group]) => group.type === "Room" || group.type === "Zone")
      .map(([id, group]) => ({
        id,
        name: group.name,
        members: group.lights.map((lightId) => ({ provider: this.id, id: lightId })),
        state: stateFor(group.action),
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
      case "color": {
        const { h, s } = rgbToHs(command.red, command.green, command.blue);
        state = { hue: Math.round(h * 65535), sat: Math.round(s * 254) };
        break;
      }
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

function stateFor(state: HueLight["state"]): LightState | undefined {
  if (!state) return undefined;
  const result: LightState = {};
  if (state.on !== undefined) result.on = state.on;
  if (state.bri !== undefined) result.brightness = Math.round((state.bri / 254) * 100);
  if (state.colormode !== "ct") {
    if (state.colormode === "xy" && Array.isArray(state.xy) && state.xy.length >= 2) {
      result.color = xyToRgb(state.xy[0], state.xy[1]);
    } else if (typeof state.hue === "number" && typeof state.sat === "number") {
      result.color = hsToRgb(state.hue / 65535, state.sat / 254);
    }
  }
  if (state.ct !== undefined) result.temperature = Math.round(1_000_000 / state.ct);
  return result;
}

// Maps a CIE xy point back to sRGB. Used to show the light's actual color
// in the picker when the bridge reports xy colormode.
function xyToRgb(x: number, y: number): { red: number; green: number; blue: number } {
  const z = 1 - x - y;
  let r = x * 1.656492 - y * 0.354851 - z * 0.255038;
  let g = -x * 0.707196 + y * 1.655397 + z * 0.036152;
  let b = x * 0.051713 - y * 0.121364 + z * 1.01153;
  const gamma = (value: number): number =>
    value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  // Out-of-gamut xy points can produce tiny negative linear values; clamp
  // before gamma so Math.pow never sees a negative base.
  const channel = (value: number): number =>
    Math.round(clamp(gamma(clamp(value, 0, 1)) * 255, 0, 255));
  return { red: channel(r), green: channel(g), blue: channel(b) };
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

