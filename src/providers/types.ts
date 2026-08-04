export type LightCapability = {
  type: string;
  instance: string;
  parameters?: Record<string, unknown>;
};

export type LightDevice = {
  id: string;
  provider: string;
  name: string;
  model: string;
  capabilities: LightCapability[];
};

export type LightCommand =
  | { type: "power"; on: boolean }
  | { type: "brightness"; value: number }
  | { type: "color"; red: number; green: number; blue: number }
  | { type: "temperature"; value: number };

export interface LightProvider {
  readonly id: string;
  readonly name: string;
  listDevices(): Promise<LightDevice[]>;
  control(deviceId: string, command: LightCommand): Promise<void>;
}
