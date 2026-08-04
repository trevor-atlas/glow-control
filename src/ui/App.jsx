import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

function hasCapability(device, type, instance) {
  return device.capabilities.some((capability) => capability.type === type && capability.instance === instance);
}

function useLightSocket() {
  const socketRef = useRef(null);
  const reconnectTimer = useRef(null);
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState({ devices: [], configuredProviders: [], hueConfigured: false });
  const [toast, setToast] = useState(null);
  const [hueBridges, setHueBridges] = useState([]);
  const [discoveringHue, setDiscoveringHue] = useState(false);
  const [pairingHue, setPairingHue] = useState(false);
  const [huePairCount, setHuePairCount] = useState(0);

  const notify = useCallback((message, error = false) => {
    setToast({ message, error });
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const send = useCallback((message) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      notify("Connecting to the light controller…", true);
      return false;
    }
    socket.send(JSON.stringify({ ...message, requestId: crypto.randomUUID() }));
    return true;
  }, [notify]);

  useEffect(() => {
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setConnected(true);
        socket.send(JSON.stringify({ type: "refresh" }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "snapshot") setSnapshot(message);
        if (message.type === "ack") notify(message.message);
        if (message.type === "error") {
          setPairingHue(false);
          notify(message.error, true);
        }
        if (message.type === "hue-discovery") {
          setHueBridges(message.bridges);
          setDiscoveringHue(false);
        }
        if (message.type === "hue-paired") {
          setPairingHue(false);
          setHuePairCount((count) => count + 1);
          notify("Hue bridge connected");
        }
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!stopped) reconnectTimer.current = window.setTimeout(connect, 1500);
      });
      socket.addEventListener("error", () => socket.close());
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer.current);
      socketRef.current?.close();
    };
  }, [notify]);

  const discoverHue = useCallback(() => {
    setDiscoveringHue(true);
    if (!send({ type: "discover-hue" })) setDiscoveringHue(false);
  }, [send]);

  const pairHue = useCallback((bridgeIp) => {
    setPairingHue(true);
    if (!send({ type: "pair-hue", bridgeIp })) setPairingHue(false);
  }, [send]);

  return { ...snapshot, connected, toast, send, hueBridges, discoveringHue, pairingHue, huePairCount, discoverHue, pairHue };
}

function DeviceCard({ device, connected, send }) {
  const [name, setName] = useState(device.customName ?? "");
  const [powerOn, setPowerOn] = useState(false);
  const [brightness, setBrightness] = useState(50);
  const [temperature, setTemperature] = useState(4000);
  const [color, setColor] = useState("#ffffff");
  const inputId = `name-${device.provider}-${device.id}`;

  useEffect(() => setName(device.customName ?? ""), [device.customName]);

  const control = (command, optimisticUpdate) => {
    optimisticUpdate?.();
    send({ type: "control", providerId: device.provider, deviceId: device.id, command });
  };

  const saveName = (event) => {
    event.preventDefault();
    send({ type: "save-name", providerId: device.provider, deviceId: device.id, name: name.trim() });
  };

  return <article className="device-card">
    <div className="device-heading">
      <div><h2 className="device-name">{device.name}</h2><p className="device-meta">{device.provider} · {device.model}</p></div>
    </div>
    <form className="name-form" onSubmit={saveName}>
      <label className="name-label" htmlFor={inputId}>Device name</label>
      <div className="name-row">
        <input id={inputId} type="text" maxLength="80" value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional name" />
        <button className="save-name-button" type="submit" disabled={!connected}>Save name</button>
      </div>
    </form>
    {hasCapability(device, "devices.capabilities.on_off", "powerSwitch") && <div className="control-row control power-control">
      <span className="control-label">Power</span>
      <button className={`power-button${powerOn ? " on" : ""}`} type="button" disabled={!connected} onClick={() => control({ type: "power", on: !powerOn }, () => setPowerOn(!powerOn))}>{powerOn ? "On" : "Off"}</button>
    </div>}
    {hasCapability(device, "devices.capabilities.range", "brightness") && <div className="control">
      <div className="control-row"><span className="control-label">Brightness</span><span className="value">{brightness}%</span></div>
      <div className="range-row"><input type="range" min="1" max="100" value={brightness} disabled={!connected} onChange={(event) => { const value = Number(event.target.value); setBrightness(value); control({ type: "brightness", value }); }} /><span /></div>
    </div>}
    {hasCapability(device, "devices.capabilities.color_setting", "colorRgb") && <div className="control">
      <div className="control-row"><span className="control-label">Color</span><input type="color" value={color} disabled={!connected} aria-label="Choose color" onChange={(event) => { const value = event.target.value; setColor(value); const [red, green, blue] = value.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16)); control({ type: "color", red, green, blue }); }} /></div>
    </div>}
    {hasCapability(device, "devices.capabilities.color_setting", "colorTemperatureK") && <div className="control">
      <div className="control-row"><span className="control-label">Color temperature</span><span className="value">{temperature.toLocaleString()}K</span></div>
      <div className="range-row"><input type="range" min="2000" max="9000" step="100" value={temperature} disabled={!connected} onChange={(event) => { const value = Number(event.target.value); setTemperature(value); control({ type: "temperature", value }); }} /><span /></div>
    </div>}
  </article>;
}

function HueSetup({ open, onClose, bridges, discovering, pairing, onDiscover, onPair }) {
  const [bridgeIp, setBridgeIp] = useState("");
  if (!open) return null;
  return <section className="setup-panel">
    <div className="setup-heading"><div><p className="eyebrow">Local connection</p><h2>Connect a Hue bridge</h2></div><button className="close-button" type="button" onClick={onClose} aria-label="Close Hue setup">×</button></div>
    <p className="setup-copy">Find your bridge on the local network. Press the round link button on top of the bridge, then click Pair bridge within 30 seconds.</p>
    <button className="secondary-button" type="button" onClick={onDiscover} disabled={discovering}>{discovering ? "Searching…" : "Find Hue bridges"}</button>
    <div className="hue-bridges" aria-live="polite">
      {!discovering && bridges.length === 0 && <span className="device-meta">No bridges found. Enter the bridge IP address below.</span>}
      {bridges.map((bridge) => <div className="bridge-option" key={bridge.internalipaddress}><span>{bridge.internalipaddress}</span><button type="button" onClick={() => setBridgeIp(bridge.internalipaddress)}>Use this bridge</button></div>)}
    </div>
    <form className="hue-pair-form" onSubmit={(event) => { event.preventDefault(); onPair(bridgeIp); }}>
      <label className="name-label" htmlFor="hue-bridge-ip">Bridge IP address</label>
      <div className="name-row"><input id="hue-bridge-ip" type="text" inputMode="url" value={bridgeIp} onChange={(event) => setBridgeIp(event.target.value)} placeholder="192.168.1.100" required /><button className="save-name-button" type="submit" disabled={pairing}>{pairing ? "Pairing…" : "Pair bridge"}</button></div>
    </form>
  </section>;
}

function App() {
  const [hueSetupOpen, setHueSetupOpen] = useState(false);
  const controller = useLightSocket();
  const { devices, connected, toast, send, hueBridges, discoveringHue, pairingHue, huePairCount, discoverHue, pairHue } = controller;
  useEffect(() => {
    if (huePairCount > 0) setHueSetupOpen(false);
  }, [huePairCount]);

  return <main className="shell">
    <header className="hero">
      <div><p className="eyebrow">Home lighting</p><h1>Glow control</h1><p className="subtitle">A small, local-first remote for your smart lights.</p></div>
      <div className="header-actions"><span className={`connection-status${connected ? " connected" : ""}`}><span />{connected ? "Live" : "Reconnecting"}</span><button className="secondary-button" type="button" onClick={() => setHueSetupOpen(!hueSetupOpen)}>Set up Hue bridge</button><button className="secondary-button" type="button" disabled={!connected} onClick={() => send({ type: "refresh" })}>Refresh devices</button></div>
    </header>
    <HueSetup open={hueSetupOpen} onClose={() => setHueSetupOpen(false)} bridges={hueBridges} discovering={discoveringHue} pairing={pairingHue} onDiscover={discoverHue} onPair={pairHue} />
    <section className="device-grid" aria-live="polite">{devices.length ? devices.map((device) => <DeviceCard key={`${device.provider}:${device.id}`} device={device} connected={connected} send={send} />) : <div className="empty">{connected ? "No lights found. Check your provider configuration." : "Connecting to the light controller…"}</div>}</section>
    {toast && <div className={`toast visible${toast.error ? " error" : ""}`} role="status" aria-live="polite">{toast.message}</div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
