import React, { useCallback, useEffect, useRef, useState } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { CloseButton, Dialog, DialogBackdrop, DialogPanel, DialogTitle, Input, Switch } from "@headlessui/react";

function hasCapability(device, type, instance) {
  return device.capabilities.some((capability) => capability.type === type && capability.instance === instance);
}

function rgbToHex({ red, green, blue }) {
  const channel = (value) => value.toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function useLightSocket() {
  const socketRef = useRef(null);
  const reconnectTimer = useRef(null);
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState({ devices: [], groups: [], configuredProviders: [], hueConfigured: false, hueBridgeIp: null, elgatoLights: [] });
  const [toast, setToast] = useState(null);
  const [hueBridges, setHueBridges] = useState([]);
  const [discoveringHue, setDiscoveringHue] = useState(false);
  const [pairingHue, setPairingHue] = useState(false);
  const [huePairCount, setHuePairCount] = useState(0);
  const [elgatoDiscovered, setElgatoDiscovered] = useState([]);
  const [discoveringElgato, setDiscoveringElgato] = useState(false);
  const [elgatoBusy, setElgatoBusy] = useState("");

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
        if (message.type === "ack") {
          setElgatoBusy("");
          notify(message.message);
        }
        if (message.type === "error") {
          setPairingHue(false);
          setDiscoveringElgato(false);
          setElgatoBusy("");
          notify(message.error, true);
        }
        if (message.type === "hue-discovery") {
          setHueBridges(message.bridges);
          setDiscoveringHue(false);
        }
        if (message.type === "elgato-discovery") {
          setElgatoDiscovered(message.lights);
          setDiscoveringElgato(false);
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

  const discoverElgato = useCallback(() => {
    setDiscoveringElgato(true);
    if (!send({ type: "discover-elgato" })) setDiscoveringElgato(false);
  }, [send]);

  const addElgatoLight = useCallback((ip) => {
    setElgatoBusy(`add:${ip}`);
    if (!send({ type: "add-elgato-light", ip })) setElgatoBusy("");
  }, [send]);

  const removeElgatoLight = useCallback((id) => {
    setElgatoBusy(`remove:${id}`);
    if (!send({ type: "remove-elgato-light", id })) setElgatoBusy("");
  }, [send]);

  const flashElgatoLight = useCallback((id) => {
    setElgatoBusy(`flash:${id}`);
    if (!send({ type: "flash-elgato-light", id })) setElgatoBusy("");
  }, [send]);

  return { ...snapshot, connected, toast, send, hueBridges, discoveringHue, pairingHue, huePairCount, discoverHue, pairHue, elgatoDiscovered, discoveringElgato, elgatoBusy, discoverElgato, addElgatoLight, removeElgatoLight, flashElgatoLight };
}

function ColorControl({ device, connected, send }) {
  const [color, setColor] = useState(() => (device.state?.color ? rgbToHex(device.state.color) : "#ffffff"));
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Keep the picker in sync with server-reported color (initial load, other
  // clients, revert after a failed control).
  useEffect(() => {
    if (device.state?.color) setColor(rgbToHex(device.state.color));
  }, [device.state?.color?.red, device.state?.color?.green, device.state?.color?.blue]);

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
  const [brightness, setBrightness] = useState(device.state?.brightness ?? 50);
  const [temperature, setTemperature] = useState(device.state?.temperature ?? 4000);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setName(device.customName ?? "");
  }, [device.customName, editing]);
  // Keep the switch in sync with server-reported state (initial load, other
  // clients, revert after a failed control). No-op when unchanged.
  useEffect(() => {
    if (device.state?.on !== undefined) setPowerOn(device.state.on);
  }, [device.state?.on]);
  // Same for brightness and temperature, so the sliders reflect the light's
  // actual values instead of a hardcoded default. Clamp to the slider range.
  useEffect(() => {
    if (device.state?.brightness !== undefined) {
      setBrightness(Math.min(100, Math.max(1, Math.round(device.state.brightness))));
    }
  }, [device.state?.brightness]);
  useEffect(() => {
    if (device.state?.temperature !== undefined) {
      setTemperature(Math.min(9000, Math.max(2000, device.state.temperature)));
    }
  }, [device.state?.temperature]);

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

function GroupCard({ group, devices, connected, send }) {
  const [powerOn, setPowerOn] = useState(group.state?.on ?? false);
  const [brightness, setBrightness] = useState(group.state?.brightness ?? 50);
  const [temperature, setTemperature] = useState(group.state?.temperature ?? 4000);

  // Keep the card in sync with server-reported state (initial load, other
  // clients, revert after a failed control).
  useEffect(() => {
    if (group.state?.on !== undefined) setPowerOn(group.state.on);
  }, [group.state?.on]);
  useEffect(() => {
    if (group.state?.brightness !== undefined) {
      setBrightness(Math.min(100, Math.max(1, Math.round(group.state.brightness))));
    }
  }, [group.state?.brightness]);
  useEffect(() => {
    if (group.state?.temperature !== undefined) {
      setTemperature(Math.min(9000, Math.max(2000, group.state.temperature)));
    }
  }, [group.state?.temperature]);

  // Resolve member refs to full device records for names, state and capabilities.
  const members = group.members
    .map((ref) => devices.find((device) => device.provider === ref.provider && device.id === ref.id))
    .filter(Boolean);

  const control = (command) => send({ type: "control-group", id: group.id, command });
  const hasBrightness = members.some((device) => hasCapability(device, "devices.capabilities.range", "brightness"));
  const hasTemperature = members.some((device) => hasCapability(device, "devices.capabilities.color_setting", "colorTemperatureK"));

  return <article className="device-card">
    <div className="device-heading">
      <div>
        <h2 className="device-name">{group.name}</h2>
        <p className="device-meta">{group.source === "provider" ? `${group.providerId} group` : "Group"}{members.length > 0 && ` · ${members.length} ${members.length === 1 ? "device" : "devices"}`}</p>
      </div>
      <Switch checked={powerOn} onChange={(on) => control({ type: "power", on })} disabled={!connected} aria-label={`Toggle ${group.name}`} className="power-switch">
        <span className="power-thumb" />
      </Switch>
    </div>
    {members.length > 0 && <div className="group-members">
      {members.map((device) => <span key={`${device.provider}:${device.id}`} className={`group-member${device.state?.on ? " on" : ""}`}>{device.name}</span>)}
    </div>}
    {hasBrightness && <div className="control">
      <div className="control-row"><span className="control-label">Brightness</span><span className="value">{brightness}%</span></div>
      <div className="range-row"><input type="range" min="1" max="100" value={brightness} disabled={!connected} onChange={(event) => { const value = Number(event.target.value); setBrightness(value); control({ type: "brightness", value }); }} /><span /></div>
    </div>}
    {hasTemperature && <div className="control">
      <div className="control-row"><span className="control-label">Color temperature</span><span className="value">{temperature.toLocaleString()}K</span></div>
      <div className="range-row"><input type="range" min="2000" max="9000" step="100" value={temperature} disabled={!connected} onChange={(event) => { const value = Number(event.target.value); setTemperature(value); control({ type: "temperature", value }); }} /><span /></div>
    </div>}
  </article>;
}

function SetupPanel({ open, onClose, hueBridgeIp, bridges, discovering, pairing, onDiscover, onPair, elgatoDiscovered, discoveringElgato, elgatoBusy, elgatoLights, onDiscoverElgato, onAddElgato, onRemoveElgato, onFlashElgato }) {
  const [bridgeIp, setBridgeIp] = useState("");
  const [elgatoIp, setElgatoIp] = useState("");
  return <Dialog open={open} onClose={onClose} transition className="dialog-root">
    <DialogBackdrop transition className="dialog-backdrop" />
    <div className="dialog-positioner">
      <DialogPanel transition className="setup-panel">
        <div className="setup-heading"><div><p className="eyebrow">Local connections</p><DialogTitle>Set up lights</DialogTitle></div><CloseButton className="close-button" aria-label="Close setup">×</CloseButton></div>
        <div className="setup-block">
          <p className="setup-copy"><strong>Philips Hue</strong> — find your bridge on the local network. Press the round link button on top of the bridge, then click Pair bridge within 30 seconds.</p>
          {hueBridgeIp && <div className="hue-bridges">
            <div className="bridge-option"><span><span className="connection-status connected"><span />Connected</span> · {hueBridgeIp}</span></div>
          </div>}
          <button className="secondary-button" type="button" onClick={onDiscover} disabled={discovering}>{discovering ? "Searching…" : "Find Hue bridges"}</button>
          <div className="hue-bridges" aria-live="polite">
            {!discovering && !hueBridgeIp && bridges.length === 0 && <span className="device-meta">No bridges found. Enter the bridge IP address below.</span>}
            {bridges.filter((bridge) => bridge.internalipaddress !== hueBridgeIp).map((bridge) => <div className="bridge-option" key={bridge.internalipaddress}><span>{bridge.internalipaddress}</span><button type="button" onClick={() => setBridgeIp(bridge.internalipaddress)}>Use this bridge</button></div>)}
          </div>
          <form className="hue-pair-form" onSubmit={(event) => { event.preventDefault(); onPair(bridgeIp); }}>
            <label className="setup-label" htmlFor="hue-bridge-ip">Bridge IP address</label>
            <div className="setup-row"><input id="hue-bridge-ip" type="text" inputMode="url" value={bridgeIp} onChange={(event) => setBridgeIp(event.target.value)} placeholder="192.168.1.100" required /><button className="save-name-button" type="submit" disabled={pairing}>{pairing ? "Pairing…" : "Pair bridge"}</button></div>
          </form>
        </div>
        <div className="setup-block">
          <p className="setup-copy"><strong>Elgato Key Lights</strong> — find your lights on the local network, or add one by IP address.</p>
          <div className="setup-row">
            <input id="elgato-ip" type="text" inputMode="url" value={elgatoIp} onChange={(event) => setElgatoIp(event.target.value)} placeholder="192.168.1.100" />
            <button className="save-name-button" type="button" disabled={Boolean(elgatoBusy)} onClick={() => { const ip = elgatoIp.trim(); if (ip) onAddElgato(ip); }}>Add by IP</button>
          </div>
          <button className="secondary-button" type="button" onClick={onDiscoverElgato} disabled={discoveringElgato}>{discoveringElgato ? "Searching…" : "Find Elgato lights"}</button>
          <div className="hue-bridges" aria-live="polite">
            {!discoveringElgato && elgatoDiscovered.length === 0 && <span className="device-meta">No lights found. Elgato lights advertise on the local network via mDNS.</span>}
            {elgatoDiscovered.map((light) => <div className="bridge-option" key={`${light.id}@${light.ip}`}><span>{light.name}{light.model ? ` (${light.model})` : ""} · {light.ip}</span><button type="button" disabled={Boolean(elgatoBusy)} onClick={() => onAddElgato(light.ip)}>Add</button></div>)}
          </div>
          {elgatoLights.length > 0 && <div className="hue-bridges">
            <span className="device-meta">Added lights</span>
            {elgatoLights.map((light) => <div className="bridge-option" key={light.id}><span>{light.name ?? light.id} · {light.ip}</span><span className="setup-row"><button type="button" disabled={Boolean(elgatoBusy)} onClick={() => onFlashElgato(light.id)}>Flash</button><button type="button" disabled={Boolean(elgatoBusy)} onClick={() => onRemoveElgato(light.id)}>Remove</button></span></div>)}
          </div>}
        </div>
      </DialogPanel>
    </div>
  </Dialog>;
}

function GroupsManager({ open, onClose, groups, devices, connected, send }) {
  const manualGroups = groups.filter((group) => group.source === "manual");
  const providerGroups = groups.filter((group) => group.source === "provider");

  const inGroup = (group, device) =>
    group.members.some((ref) => ref.provider === device.provider && ref.id === device.id);

  // Toggle a device in/out of a group. Because a device is a plain ref, moving
  // it between groups is just checking it here and unchecking it there.
  const toggleDevice = (group, device) => {
    const members = inGroup(group, device)
      ? group.members.filter((ref) => !(ref.provider === device.provider && ref.id === device.id))
      : [...group.members, { provider: device.provider, id: device.id }];
    send({ type: "update-group", id: group.id, members });
  };

  return <Dialog open={open} onClose={onClose} transition className="dialog-root">
    <DialogBackdrop transition className="dialog-backdrop" />
    <div className="dialog-positioner">
      <DialogPanel transition className="setup-panel">
        <div className="setup-heading"><div><p className="eyebrow">Groups</p><DialogTitle>Manage groups</DialogTitle></div><CloseButton className="close-button" aria-label="Close groups">×</CloseButton></div>
        <div className="setup-block">
          <p className="setup-copy">Groups are collections of devices you can control together. Tick the devices you want in each group; a device can be in more than one.</p>
          <button className="secondary-button" type="button" disabled={!connected} onClick={() => send({ type: "create-group", name: "New group", members: [] })}>New group</button>
        </div>
        {manualGroups.map((group) => <div className="setup-block" key={group.id}>
          <div className="group-editor-heading">
            <Input className="name-input" defaultValue={group.name} maxLength={80} disabled={!connected} aria-label="Group name"
              onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== group.name) send({ type: "update-group", id: group.id, name }); }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = group.name; event.currentTarget.blur(); } }} />
            <button className="close-button" type="button" aria-label={`Delete ${group.name}`} disabled={!connected} onClick={() => send({ type: "delete-group", id: group.id })}>×</button>
          </div>
          <div className="group-device-list">
            {devices.map((device) => (
              <label className="group-device-row" key={`${device.provider}:${device.id}`}>
                <input type="checkbox" checked={inGroup(group, device)} disabled={!connected} onChange={() => toggleDevice(group, device)} />
                <span className="group-device-name">{device.name}<span className="device-meta"> {device.provider} · {device.model}</span></span>
              </label>
            ))}
            {devices.length === 0 && <span className="device-meta">No devices connected yet.</span>}
          </div>
        </div>)}
        {manualGroups.length === 0 && <div className="setup-block"><p className="device-meta">No groups yet — create one to start grouping your devices.</p></div>}
        {providerGroups.length > 0 && <div className="setup-block">
          <p className="setup-copy"><strong>Synced from providers</strong> — these groups come from your connected providers and are read-only here. Control them from the main screen.</p>
          {providerGroups.map((group) => <div className="bridge-option" key={group.id}><span>{group.name} · {group.members.length} {group.members.length === 1 ? "device" : "devices"}</span><span className="device-meta">{group.providerId}</span></div>)}
        </div>}
      </DialogPanel>
    </div>
  </Dialog>;
}

function App() {
  const [setupOpen, setSetupOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const controller = useLightSocket();
  const { devices, groups, connected, toast, send, hueBridges, hueBridgeIp, discoveringHue, pairingHue, huePairCount, discoverHue, pairHue, elgatoDiscovered, discoveringElgato, elgatoBusy, discoverElgato, addElgatoLight, removeElgatoLight, flashElgatoLight, elgatoLights } = controller;
  useEffect(() => {
    if (huePairCount > 0) setSetupOpen(false);
  }, [huePairCount]);

  const onDevices = devices.filter((device) => device.state?.on === true);
  const offDevices = devices.filter((device) => device.state?.on !== true);

  return <main className="shell">
    <header className="hero">
      <div><p className="eyebrow">Home lighting</p><h1>Glow control</h1><p className="subtitle">A small, local-first remote for your smart lights.</p></div>
      <div className="header-actions"><span className={`connection-status${connected ? " connected" : ""}`}><span />{connected ? "Live" : "Reconnecting"}</span><button className="secondary-button" type="button" onClick={() => setGroupsOpen(!groupsOpen)}>Groups</button><button className="secondary-button" type="button" onClick={() => setSetupOpen(!setupOpen)}>Set up lights</button><button className="secondary-button" type="button" disabled={!connected} onClick={() => send({ type: "refresh" })}>Refresh devices</button></div>
    </header>
    <SetupPanel open={setupOpen} onClose={() => setSetupOpen(false)} hueBridgeIp={hueBridgeIp} bridges={hueBridges} discovering={discoveringHue} pairing={pairingHue} onDiscover={discoverHue} onPair={pairHue} elgatoDiscovered={elgatoDiscovered} discoveringElgato={discoveringElgato} elgatoBusy={elgatoBusy} elgatoLights={elgatoLights ?? []} onDiscoverElgato={discoverElgato} onAddElgato={addElgatoLight} onRemoveElgato={removeElgatoLight} onFlashElgato={flashElgatoLight} />
    <GroupsManager open={groupsOpen} onClose={() => setGroupsOpen(false)} groups={groups} devices={devices} connected={connected} send={send} />
    {groups.length > 0 && <>
      <h2 className="group-heading">Groups{groups.length > 1 ? ` (${groups.length})` : ""}</h2>
      <section className="device-grid" aria-live="polite">{groups.map((group) => <GroupCard key={group.id} group={group} devices={devices} connected={connected} send={send} />)}</section>
    </>}
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

export default App;
