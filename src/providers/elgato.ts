import { ProviderError } from "./govee";
import type { LightCapability, LightCommand, LightDevice, LightProvider } from "./types";

const ELGATO_PORT = 9123;
const REQUEST_TIMEOUT_MS = 2_000;
/** API temperature units are Kelvin × 0.05 (the Control Center range is 2900K–7000K). */
const TEMPERATURE_MIN = 143;
const TEMPERATURE_MAX = 344;

export type ElgatoLightConfig = {
  id: string;
  ip: string;
  name?: string;
  /** Defaults to 9123; overridable for testing or proxy setups. */
  port?: number;
};

type ElgatoLightState = {
  on: number;
  brightness?: number;
  temperature?: number;
  /** Present on models that support color (Key Light Air and newer firmware). */
  hue?: number;
  saturation?: number;
};

type ElgatoLightsResponse = {
  numberOfLights: number;
  lights: ElgatoLightState[];
};

type ElgatoAccessoryInfo = {
  productName?: string;
  serialNumber?: string;
  firmwareVersion?: string;
};

export class ElgatoProvider implements LightProvider {
  readonly id = "elgato";
  readonly name = "Elgato";
  private readonly lights = new Map<string, ElgatoLightConfig>();
  private readonly resolved = new Map<string, { light: ElgatoLightConfig; index: number }>();

  constructor(config: ElgatoLightConfig[]) {
    for (const light of config) this.lights.set(light.id, light);
  }

  async listDevices(): Promise<LightDevice[]> {
    const results = await Promise.allSettled(
      [...this.lights.values()].map((light) => this.listOne(light)),
    );
    return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  }

  async control(deviceId: string, command: LightCommand): Promise<void> {
    const entry = await this.entryFor(deviceId);
    await ElgatoProvider.requestJson(entry.light, "/elgato/lights", {
      method: "PUT",
      body: JSON.stringify({
        numberOfLights: 1,
        lights: [{ ...this.fieldsFor(command) }],
      }),
    });
  }

  async getState(deviceId: string): Promise<{ on?: boolean } | null> {
    const entry = await this.entryFor(deviceId).catch(() => null);
    if (!entry) return null;
    const body = await ElgatoProvider.requestJson<ElgatoLightsResponse>(
      entry.light,
      "/elgato/lights",
    ).catch(() => null);
    const light = body?.lights?.[entry.index];
    return light ? { on: light.on === 1 } : null;
  }

  /** Probe an IP to confirm it is an Elgato light and fetch its identity (serial + product name). */
  static async discoverAt(ip: string): Promise<ElgatoLightConfig> {
    const normalized = normalizeIp(ip);
    const light = { id: "probe", ip: normalized };
    const [info, lights] = await Promise.all([
      ElgatoProvider.requestJson<ElgatoAccessoryInfo>(light, "/elgato/accessory-info"),
      ElgatoProvider.requestJson<ElgatoLightsResponse>(light, "/elgato/lights"),
    ]);
    void lights;
    return {
      id: info.serialNumber || `elgato-${normalized}`,
      ip: normalized,
      name: info.productName ?? "Elgato Key Light",
    };
  }

  /** Blink the light so the user can confirm which physical unit an entry refers to. */
  static async flash(light: ElgatoLightConfig): Promise<void> {
    await ElgatoProvider.requestJson(light, "/elgato/identify", { method: "POST" });
  }

  private async listOne(light: ElgatoLightConfig): Promise<LightDevice[]> {
    const body = await ElgatoProvider.requestJson<ElgatoLightsResponse>(light, "/elgato/lights");
    const info = await ElgatoProvider.requestJson<ElgatoAccessoryInfo>(
      light,
      "/elgato/accessory-info",
    ).catch(() => null);
    const entries = body.lights.length ? body.lights : [{ on: 0 }];
    return entries.map((entry, index) => {
      const id = entries.length > 1 ? `${light.id}:${index}` : light.id;
      this.resolved.set(id, { light, index });
      return {
        id,
        provider: this.id,
        name: light.name ?? info?.productName ?? `Elgato light (${light.ip})`,
        model: info?.productName ?? "Elgato Key Light",
        capabilities: capabilitiesFor(entry),
        state: { on: entry.on === 1 },
      };
    });
  }

  private async entryFor(deviceId: string): Promise<{ light: ElgatoLightConfig; index: number }> {
    const cached = this.resolved.get(deviceId);
    if (cached) return cached;
    const configId = deviceId.split(":")[0];
    const light = this.lights.get(configId);
    if (!light) {
      throw new ProviderError(`Elgato light ${deviceId} was not found`, 404);
    }
    await this.listOne(light);
    const entry = this.resolved.get(deviceId);
    if (!entry) {
      throw new ProviderError(`Elgato light ${deviceId} was not found`, 404);
    }
    return entry;
  }

  private fieldsFor(command: LightCommand): Record<string, unknown> {
    switch (command.type) {
      case "power":
        return { on: command.on ? 1 : 0 };
      case "brightness":
        return { brightness: Math.round(clamp(command.value, 0, 100)) };
      case "temperature":
        return {
          temperature: Math.round(clamp(command.value * 0.05, TEMPERATURE_MIN, TEMPERATURE_MAX)),
        };
      case "color": {
        const { hue, saturation } = rgbToHsv(command.red, command.green, command.blue);
        return { hue, saturation };
      }
    }
  }

  private static async requestJson<T>(
    light: { ip: string; port?: number },
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = `http://${light.ip}:${light.port ?? ELGATO_PORT}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError(`Could not reach Elgato light at ${light.ip}`, 502);
    }
    if (!response.ok) {
      throw new ProviderError(
        `Elgato light ${light.ip} returned HTTP ${response.status}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

function capabilitiesFor(state: ElgatoLightState): LightCapability[] {
  const capabilities: LightCapability[] = [
    { type: "devices.capabilities.on_off", instance: "powerSwitch" },
    { type: "devices.capabilities.range", instance: "brightness" },
    { type: "devices.capabilities.color_setting", instance: "colorTemperatureK" },
  ];
  if (state.hue !== undefined || state.saturation !== undefined) {
    capabilities.push({ type: "devices.capabilities.color_setting", instance: "colorRgb" });
  }
  return capabilities;
}

function normalizeIp(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!trimmed || trimmed.includes("/") || trimmed.includes(" ") || !/^[\d.]+$/.test(trimmed)) {
    throw new ProviderError("Enter a valid Elgato light IP address", 400);
  }
  return trimmed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rgbToHsv(red: number, green: number, blue: number): { hue: number; saturation: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  const saturation = max === 0 ? 0 : (delta / max) * 100;
  return { hue: Math.round(hue), saturation: Math.round(saturation) };
}
