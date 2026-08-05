import { Bonjour } from "bonjour-service";
import type { ElgatoLightConfig } from "./elgato";

export type DiscoveredElgatoLight = ElgatoLightConfig & { model?: string };

/**
 * Browse for Elgato lights advertising `_elg._tcp` on the local network.
 * Resolves as soon as the timeout elapses; `bonjour.destroy()` is called to
 * leave the multicast group. Elgato lights publish no cloud service and no
 * SSDP, so mDNS is the only on-network discovery path.
 */
export function discoverElgatoLights(timeoutMs = 3_000): Promise<DiscoveredElgatoLight[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredElgatoLight>();
    let bonjour: Bonjour | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        bonjour?.destroy();
      } catch {
        // ignore teardown errors
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    try {
      bonjour = new Bonjour();
      bonjour.find({ type: "elg" }, (service) => {
        const ip =
          firstIpv4(service.addresses) ??
          (typeof service.host === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(service.host)
            ? service.host
            : undefined);
        if (!ip) return;
        const key = `${service.name}@${ip}`;
        if (found.has(key)) return;

        const txt =
          service.txt && typeof service.txt === "object"
            ? (service.txt as Record<string, unknown>)
            : {};
        const model = pick(txt, "productname", "productName", "model", "product");
        const serial = pick(txt, "serial", "serialnumber", "serialNumber", "id");
        found.set(key, {
          // Authoritative identity is fetched from /elgato/accessory-info at add time.
          id: serial ? String(serial) : `elgato-${ip}`,
          ip,
          name: String(pick(txt, "name", "n") ?? service.name ?? "Elgato light"),
          model: model ? String(model) : "Elgato light",
        });
      });
    } catch (error) {
      console.warn("Elgato mDNS discovery unavailable.", error);
      finish();
    }
  });
}

function firstIpv4(addresses: unknown): string | undefined {
  if (!Array.isArray(addresses)) return undefined;
  return addresses.find(
    (address): address is string =>
      typeof address === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(address),
  );
}

function pick(txt: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (txt[key] !== undefined) return txt[key];
  }
  return undefined;
}
