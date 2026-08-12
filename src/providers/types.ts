export type LightCapability = {
  type: string;
  instance: string;
  parameters?: Record<string, unknown>;
};

/** Known state of a light; each field is undefined when unknown. */
export type LightState = {
  /** On/off. */
  on?: boolean;
  /** Brightness as a percentage, 0–100. */
  brightness?: number;
  /** RGB color, 0–255 per channel. */
  color?: { red: number; green: number; blue: number };
  /** Color temperature in Kelvin. */
  temperature?: number;
};

export type LightDevice = {
  id: string;
  provider: string;
  name: string;
  model: string;
  capabilities: LightCapability[];
  /** Known state; undefined when unknown. */
  state?: LightState;
};

export type LightCommand =
  | { type: "power"; on: boolean }
  | { type: "brightness"; value: number }
  | { type: "color"; red: number; green: number; blue: number }
  | { type: "temperature"; value: number };

/** A device reference anywhere in the system: provider + provider-local id. */
export type DeviceRef = {
  provider: string;
  id: string;
};

/**
 * A group as reported by a provider (rooms, zones, …). Providers that know
 * about grouping of their own devices can seed groups through listGroups().
 */
export type ProviderGroup = {
  /** Provider's stable id for this group. */
  id: string;
  name: string;
  /** Devices that make up this group, as provider-local refs. */
  members: DeviceRef[];
  /** Aggregated state reported by the provider, when it has one. */
  state?: LightState;
};

/**
 * A group of devices. Groups are deliberately provider-agnostic: membership is
 * just a set of device refs, so the same model works for any device kind
 * (lights today, other device types later). Two sources exist:
 *
 * - "manual": user-defined via the app, persisted in groups.json
 * - "provider": seeded by a provider that knows about its own rooms/zones
 */
export type Group = {
  /** Stable, app-wide unique id. */
  id: string;
  name: string;
  source: "manual" | "provider";
  /** Provider that owns this group; set when source === "provider". */
  providerId?: string;
  /** Provider's own id for the group; set when source === "provider". */
  providerGroupId?: string;
  members: DeviceRef[];
  /** Aggregated state (provider-reported or derived from members). */
  state?: LightState;
};

export interface LightProvider {
  readonly id: string;
  readonly name: string;
  listDevices(): Promise<LightDevice[]>;
  control(deviceId: string, command: LightCommand): Promise<void>;
  /** Fetch a device's current state; null when unknown. */
  getState?(deviceId: string): Promise<LightState | null>;
  /** Groups this provider knows about (rooms, zones, …). Optional. */
  listGroups?(): Promise<ProviderGroup[]>;
}
