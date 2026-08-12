import type {
  LightCapability,
  LightCommand,
  LightDevice,
  LightProvider,
  LightState,
} from "./types";
import { clamp } from "./color";

const API_BASE = "https://openapi.api.govee.com";
const DEVICE_PATH = "/router/api/v1/user/devices";
const CONTROL_PATH = "/router/api/v1/device/control";
const STATE_PATH = "/router/api/v1/device/state";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type GoveeDevice = {
  sku: string;
  device: string;
  capabilities: LightCapability[];
};

type GoveeResponse<T> = {
  code: number;
  message: string;
  data: T;
};

type GoveeStateCapability = {
  type: string;
  instance: string;
  state?: { value?: unknown };
};

type GoveeStateResponse = {
  code: number;
  payload?: {
    capabilities?: GoveeStateCapability[];
  };
};

export class GoveeProvider implements LightProvider {
  readonly id = "govee";
  readonly name = "Govee";
  private devices = new Map<string, GoveeDevice>();

  constructor(private readonly apiKey: string) {}

  async listDevices(): Promise<LightDevice[]> {
    const response = await this.request<GoveeResponse<GoveeDevice[]>>(
      DEVICE_PATH,
      { method: "GET" },
    );

    this.devices = new Map(response.data.map((device) => [device.device, device]));

    return response.data.map((device) => ({
      id: device.device,
      provider: this.id,
      name: device.device,
      model: device.sku,
      capabilities: device.capabilities,
    }));
  }

  async control(deviceId: string, command: LightCommand): Promise<void> {
    let device = this.devices.get(deviceId);
    if (!device) {
      await this.listDevices();
      device = this.devices.get(deviceId);
    }

    if (!device) {
      throw new ProviderError(`Govee device ${deviceId} was not found`, 404);
    }

    const capability = this.capabilityFor(device, command.type);
    if (!capability) {
      throw new ProviderError(
        `Device ${device.sku} does not support ${command.type}`,
        400,
      );
    }

    await this.request<GoveeResponse<unknown>>(CONTROL_PATH, {
      method: "POST",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        payload: {
          sku: device.sku,
          device: device.device,
          capability: {
            type: capability.type,
            instance: capability.instance,
            value: this.valueFor(command),
          },
        },
      }),
    });
  }

  async getState(deviceId: string): Promise<LightState | null> {
    let device = this.devices.get(deviceId);
    if (!device) {
      await this.listDevices();
      device = this.devices.get(deviceId);
    }
    if (!device) return null;

    const response = await this.request<GoveeStateResponse>(STATE_PATH, {
      method: "POST",
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        payload: { sku: device.sku, device: device.device },
      }),
    });
    const capabilities = response.payload?.capabilities;
    if (!capabilities?.length) return null;

    const state: LightState = {};
    for (const entry of capabilities) {
      const value = entry.state?.value;
      if (value === undefined) continue;
      if (entry.type === "devices.capabilities.on_off" && entry.instance === "powerSwitch") {
        state.on = value === 1 || value === true;
      } else if (entry.type === "devices.capabilities.range" && entry.instance === "brightness") {
        state.brightness = clamp(Number(value), 0, 100);
      } else if (entry.type === "devices.capabilities.color_setting" && entry.instance === "colorRgb") {
        const rgb = Number(value);
        if (Number.isInteger(rgb) && rgb >= 0) {
          state.color = {
            red: (rgb >> 16) & 0xff,
            green: (rgb >> 8) & 0xff,
            blue: rgb & 0xff,
          };
        }
      } else if (entry.type === "devices.capabilities.color_setting" && entry.instance === "colorTemperatureK") {
        state.temperature = Number(value);
      }
    }
    return Object.keys(state).length ? state : null;
  }

  private capabilityFor(
    device: GoveeDevice,
    commandType: LightCommand["type"],
  ): LightCapability | undefined {
    const expected: Record<LightCommand["type"], [string, string]> = {
      power: ["devices.capabilities.on_off", "powerSwitch"],
      brightness: ["devices.capabilities.range", "brightness"],
      color: ["devices.capabilities.color_setting", "colorRgb"],
      temperature: ["devices.capabilities.color_setting", "colorTemperatureK"],
    };
    const [type, instance] = expected[commandType];
    return device.capabilities.find(
      (capability) => capability.type === type && capability.instance === instance,
    );
  }

  private valueFor(command: LightCommand): number {
    switch (command.type) {
      case "power":
        return command.on ? 1 : 0;
      case "brightness":
      case "temperature":
        return command.value;
      case "color":
        return (command.red << 16) | (command.green << 8) | command.blue;
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "Govee-API-Key": this.apiKey,
          ...init.headers,
        },
      });
    } catch {
      throw new ProviderError("Could not reach the Govee API");
    }

    const body = (await response.json().catch(() => null)) as GoveeResponse<unknown> | null;
    if (!response.ok) {
      throw new ProviderError(
        body?.message ?? `Govee API returned HTTP ${response.status}`,
        response.status,
      );
    }
    if (!body || body.code !== 200) {
      throw new ProviderError(body?.message ?? "Govee API returned an invalid response");
    }

    return body as T;
  }
}
