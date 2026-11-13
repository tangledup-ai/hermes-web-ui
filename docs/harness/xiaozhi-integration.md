# XiaoZhi voice gateway

The local companion gateway at port 8765 accepts XiaoZhi WebSocket/Opus audio.
Studio `/global-agent` receives HADP audio, uses the selected profile STT provider,
starts the Agent, and returns TTS audio to the gateway. Qwen ASR and Qwen TTS can
reuse the same profile's saved Realtime DashScope key. Credentials stay server-side.

## Configuration

Store a mode-0600 JSON file at `<getWebUiHome()>/devices/xiaozhi.json` with
`deviceId`, random `setupCode` (at least 24 characters), `websocketUrl`, and
`deviceToken` matching the gateway. The firmware OTA URL is
`http://<LAN-IP>:<Studio-port>/api/xiaozhi/ota/<setupCode>`.
The endpoint checks the setup code and Device-Id; it returns WebSocket configuration,
not firmware or Studio login credentials. Admin `/api/xiaozhi/status` exposes
connection health and the setup URL. The Devices page displays these diagnostics.

Set `ekkoLan: true` in that JSON for a compatible XiaoZhi firmware and gateway.
The OTA response enables the device's standby WebSocket. Add the gateway's
`studio.deviceCode` to **Connections → 小方盒**. The row's LAN status then follows
the physical device's WebSocket handshake and disconnect. Configure button or
automatic listening, idle timeout and Ekko or Hermes in the gateway configuration.
The external relay requires an official relay registration.

The OTA response and Devices page use the computer's current LAN address for the
WebSocket endpoint. This keeps the gateway address current when Wi-Fi changes,
without rewriting the private JSON file. When the computer's LAN address changes,
the device's stored OTA URL must still be updated to the new address: a disconnected
device cannot retrieve the new address from its old endpoint.
Do not reset all NVS or erase Wi-Fi credentials just to change the server address.

## Integration failures and verification

- Bootstrap must call `getLoopbackBaseUrl()` with no HTTP Server object argument.
  Passing a Server object creates `127.0.0.1:[object Object]` and breaks voice turns.
- MCU Ekko runs explicitly supply the profile's provider, model, and API mode.
- Gateway automatic listening must detect the speech endpoint; manual mode still
  waits for `listen.stop`. Both modes have a 32-second gateway capture limit.
- With Ekko LAN negotiation, the gateway combines two 60 ms device frames in
  each 120 ms Studio upload chunk and flushes any final partial chunk. Downlink
  Opus encoding runs one frame at a time at playback pace.
- When an Agent finishes without speakable text or a pending background task,
  the MCU receives a failure status. This lets the user distinguish a model
  that produced only internal reasoning from a completed spoken turn.
- Studio audio URLs may be relative; the gateway resolves them against Studio URL.
- DashScope may return an HTTP OSS audio URL; download its HTTPS equivalent without
  forwarding the API key to OSS.

Run `vitest` for `loopback-url`, `mcu-model-selection`, and `global-agent-server`.
Run the companion gateway test suite with the Node version matching its Opus addon.
A service-side probe reaching `completed` with downloadable HADP audio verifies
STT → Agent → TTS, but does not verify the physical microphone or speaker.

Local deployment uses the user systemd unit `xiaozhi-ekko-gateway.service`.
The unit starts with the user's session and restarts on failure. Its private config
and log are under `/home/kali/dev/hardware/.live/`; never commit these credentials.
