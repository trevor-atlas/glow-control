import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { Input, Switch } from "@headlessui/react";

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

function ColorControl({ device, connected, send }) {
  const [color, setColor] = useState("#ffffff");
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Commit only when the user finishes picking (mouseup/keyup/blur) instead of
  // on every drag tick, so we don't flood the bridge with control messages.
  const commit = useCallback((value) => {
    const hex = (typeof value === "string" ? value : color).replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(hex)) return;
    const red = parseInt(hex.slice(0, 2), 16);
    const green = parseInt(hex.slice(2, 4), 16);
    const blue = parseInt(hex.slice(4, 6), 16);
    send({ type: "control", providerId: device.provider, deviceId: device.id, command: { type: "color", red, green, blue } });
  }, [color, device, send]);

  const palette = device.palette ?? [];
  const paletteFull = palette.length >= 12;
  const inPalette = palette.some((entry) => entry.toLowerCase() === color.toLowerCase());

  const applyPreset = useCallback((hex) => {
    setColor(hex);
    const red = parseInt(hex.slice(1, 3), 16);
    const green = parseInt(hex.slice(3, 5), 16);
    const blue = parseInt(hex.slice(5, 7), 16);
    send({ type: "control", providerId: device.provider, deviceId: device.id, command: { type: "color", red, green, blue } });
  }, [device, send]);

  const addPreset = useCallback(() => {
    if (palette.some((entry) => entry.toLowerCase() === color.toLowerCase())) return;
    send({ type: "add-palette-color", providerId: device.provider, deviceId: device.id, color });
    setOpen(false);
  }, [palette, color, device, send]);

  const removePreset = useCallback((hex) => {
    send({ type: "remove-palette-color", providerId: device.provider, deviceId: device.id, color: hex });
  }, [device, send]);

  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return <div className="control" ref={rootRef}>
    <div className="control-row">
      <span className="control-label">Color</span>
      <button className={`color-swatch${open ? " open" : ""}`} type="button" style={{ backgroundColor: color }} aria-label="Choose color" aria-haspopup="dialog" aria-expanded={open} disabled={!connected} onClick={() => setOpen((current) => !current)} />
    </div>
    <div className="presets-row">
      {palette.map((hex) => (
        <div className="preset-wrap" key={hex}>
          <button className="preset-swatch" type="button" style={{ backgroundColor: hex }} title={hex} aria-label={`Apply preset ${hex}`} disabled={!connected} onClick={() => applyPreset(hex)} />
          <button className="preset-remove" type="button" aria-label={`Remove preset ${hex}`} disabled={!connected} onClick={() => removePreset(hex)}>×</button>
        </div>
      ))}
      <button className="preset-add" type="button" aria-label="Add a preset color" title={paletteFull ? "Presets are full" : "Add a preset color"} disabled={!connected} onClick={() => setOpen(true)}>+</button>
    </div>
    {open && <div className="color-popover">
      <HexColorPicker color={color} onChange={setColor} onChangeEnd={commit} />
      <div className="color-hex-row">
        <HexColorInput className="color-hex-input" color={color} onChange={setColor} onBlur={() => commit()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} prefixed />
      </div>
      <div className="color-popover-footer">
        <button className="save-name-button" type="button" disabled={!connected || paletteFull || inPalette} onClick={addPreset}>{inPalette ? "Already a preset" : "Add to presets"}</button>
      </div>
    </div>}
  </div>;
}

function DeviceCard({ device, connected, send }) {
  const [name, setName] = useState(device.customName ?? "");
  const [powerOn, setPowerOn] = useState(device.state?.on ?? false);
  const [brightness, setBrightness] = useState(50);
  const [temperature, setTemperature] = useState(4000);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setName(device.customName ?? "");
  }, [device.customName, editing]);
  // Keep the switch in sync with server-reported state (initial load, other
  // clients, revert after a failed control). No-op when unchanged.
  useEffect(() => {
    if (device.state?.on !== undefined) setPowerOn(device.state.on);
  }, [device.state?.on]);

  const control = (command, optimisticUpdate) => {
    optimisticUpdate?.();
    send({ type: "control", providerId: device.provider, deviceId: device.id, command });
  };

  const startEdit = () => {
    setName(device.customName ?? "");
    setEditing(true);
  };

  const commitName = () => {
    setEditing(false);
    const value = name.trim();
    if (value === (device.customName ?? "")) return; // unchanged
    setName(value);
    send({ type: "save-name", providerId: device.provider, deviceId: device.id, name: value });
  };

  const cancelName = () => {
    setEditing(false);
    setName(device.customName ?? "");
  };

  const handleNameKey = (event) => {
    if (event.key === "Enter") event.currentTarget.blur(); // commits via onBlur
    else if (event.key === "Escape") cancelName();
  };

  const hasPower = hasCapability(device, "devices.capabilities.on_off", "powerSwitch");

  return <article className="device-card">
    <div className="device-heading">
      <div>
        {editing ? (
          <Input className="name-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={device.name} disabled={!connected}
            aria-label="Device name" autoFocus onBlur={commitName} onKeyDown={handleNameKey} />
        ) : (
          <h2 className="device-name" tabIndex={connected ? 0 : -1}
            onClick={connected ? startEdit : undefined}
            onKeyDown={(event) => { if (connected && event.key === "Enter") startEdit(); }}>
            {device.name}
          </h2>
        )}
        <p className="device-meta">{device.provider} · {device.model}</p>
      </div>
      {hasPower && <Switch checked={powerOn} onChange={(on) => control({ type: "power", on }, () => setPowerOn(on))} disabled={!connected} aria-label="Toggle power" className="power-switch">
        <span className="power-thumb" />
      </Switch>}
    </div>
    {(!hasPower || powerOn) && <>
    {hasCapability(device, "devices.capabilities.range", "brightness") && <div className="control">
      <div className="control-row"><span className="control-label">Brightness</span><span className="value">{brightness}%</span></div>
      <div className="range-row"><input type="range" min="1" max="100" value={brightness} disabled={!connected} onChange={(event) => { const value = Number(event.target.value); setBrightness(value); control({ type: "brightness", value }); }} /><span /></div>
    </div>}
    {hasCapability(device, "devices.capabilities.color_setting", "colorRgb") && <ColorControl device={device} connected={connected} send={send} />}
    {hasCapability(device, "devices.capabilities.color_setting", "colorTemperatureK") && !hasCapability(device, "devices.capabilities.color_setting", "colorRgb") && <div className="control">
      <div className="control-row"><span className="control-label">Color temperature</span><span className="value">{temperature.toLocaleString()}K</span></div>
      <div className="range-row"><input type="range" min="2000" max="9000" step="100" value={temperature} disabled={!connected} onChange={(event) => { const value = Number(event.target.value); setTemperature(value); control({ type: "temperature", value }); }} /><span /></div>
    </div>}
    </>}
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
      <label className="setup-label" htmlFor="hue-bridge-ip">Bridge IP address</label>
      <div className="setup-row"><input id="hue-bridge-ip" type="text" inputMode="url" value={bridgeIp} onChange={(event) => setBridgeIp(event.target.value)} placeholder="192.168.1.100" required /><button className="save-name-button" type="submit" disabled={pairing}>{pairing ? "Pairing…" : "Pair bridge"}</button></div>
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

  const onDevices = devices.filter((device) => device.state?.on === true);
  const offDevices = devices.filter((device) => device.state?.on !== true);

  return <main className="shell">
    <header className="hero">
      <div><p className="eyebrow">Home lighting</p><h1>Glow control</h1><p className="subtitle">A small, local-first remote for your smart lights.</p></div>
      <div className="header-actions"><span className={`connection-status${connected ? " connected" : ""}`}><span />{connected ? "Live" : "Reconnecting"}</span><button className="secondary-button" type="button" onClick={() => setHueSetupOpen(!hueSetupOpen)}>Set up Hue bridge</button><button className="secondary-button" type="button" disabled={!connected} onClick={() => send({ type: "refresh" })}>Refresh devices</button></div>
    </header>
    <HueSetup open={hueSetupOpen} onClose={() => setHueSetupOpen(false)} bridges={hueBridges} discovering={discoveringHue} pairing={pairingHue} onDiscover={discoverHue} onPair={pairHue} />
    {devices.length === 0 && <section className="device-grid" aria-live="polite"><div className="empty">{connected ? "No lights found. Check your provider configuration." : "Connecting to the light controller…"}</div></section>}
    {onDevices.length > 0 && <>
      <h2 className="group-heading">On{onDevices.length > 1 ? ` (${onDevices.length})` : ""}</h2>
      <section className="device-grid" aria-live="polite">{onDevices.map((device) => <DeviceCard key={`${device.provider}:${device.id}`} device={device} connected={connected} send={send} />)}</section>
    </>}
    {offDevices.length > 0 && <>
      <h2 className="group-heading">Off{offDevices.length > 1 ? ` (${offDevices.length})` : ""}</h2>
      <section className="device-grid" aria-live="polite">{offDevices.map((device) => <DeviceCard key={`${device.provider}:${device.id}`} device={device} connected={connected} send={send} />)}</section>
    </>}
    {toast && <div className={`toast visible${toast.error ? " error" : ""}`} role="status" aria-live="polite">{toast.message}</div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
