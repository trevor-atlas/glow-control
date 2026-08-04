import dgram from "node:dgram";

export type DiscoveredHueBridge = {
  internalipaddress: string;
};

export async function discoverHueBridges(): Promise<DiscoveredHueBridge[]> {
  const cloudBridges = await discoverThroughHueService();
  const localBridges = await discoverThroughSsdp();
  const addresses = new Set([...cloudBridges, ...localBridges]);
  return [...addresses].map((internalipaddress) => ({ internalipaddress }));
}

async function discoverThroughHueService(): Promise<string[]> {
  try {
    const response = await fetch("https://discovery.meethue.com");
    if (!response.ok) {
      console.warn(`Hue cloud discovery returned HTTP ${response.status}; trying local discovery.`);
      return [];
    }
    const body = await response.json() as Array<{ internalipaddress?: unknown }>;
    return body
      .map((bridge) => bridge.internalipaddress)
      .filter((address): address is string => typeof address === "string" && address.length > 0);
  } catch (error) {
    console.warn("Hue cloud discovery unavailable; trying local discovery.", error);
    return [];
  }
}

function discoverThroughSsdp(): Promise<string[]> {
  return new Promise((resolve) => {
    const addresses = new Set<string>();
    const socket = dgram.createSocket("udp4");
    const finish = () => {
      clearTimeout(timeout);
      socket.close();
      resolve([...addresses]);
    };
    const timeout = setTimeout(finish, 1_500);

    socket.on("error", () => finish());
    socket.on("message", (message, remote) => {
      const text = message.toString();
      if (!/IpBridge|Philips Hue|hue/i.test(text)) return;
      const location = text.match(/^LOCATION:\s*([^\r\n]+)/im)?.[1]?.trim();
      try {
        addresses.add(location ? new URL(location).hostname : remote.address);
      } catch {
        addresses.add(remote.address);
      }
    });
    socket.bind(() => {
      const request = Buffer.from([
        "M-SEARCH * HTTP/1.1",
        "HOST: 239.255.255.250:1900",
        'MAN: "ssdp:discover"',
        "MX: 1",
        "ST: urn:schemas-upnp-org:device:basic:1",
        "",
        "",
      ].join("\r\n"));
      socket.send(request, 1900, "239.255.255.250");
    });
  });
}
