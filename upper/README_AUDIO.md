# AUDIO V1: upper-layer foundation (hardware streaming NOT enabled)

This branch adds verifiable byte-level primitives without changing motor FOC, CAN, or the current user control flow.

## Missing normative dependency

The attached task references `00_AUDIO_UART_PROTOCOL_V1_FROZEN.md` and `protocol_vectors.json`, but **neither is present in this repository or the attachment**. STATUS `state` and `reason` number mappings, firmware INFO capability behavior, the complete ASCII->binary transition, and golden vectors cannot be verified. **Do not use this branch to operate a motor with audio.** No UI playback control is enabled, no DATA is sent to a motor, and there is no completed P0 hardware session or 60-second virtual MCU certification.

## Audio source and validation

Export RAW from FFmpeg:

```sh
ffmpeg -i song.wav -ac 1 -ar 8000 -f s16le -acodec pcm_s16le song.raw
```

A `.raw` or `.pcm` contains no header, so rate and format **cannot be detected**. Choose 8 kHz mono signed 16-bit little-endian. Files must have positive even byte length. A `.wav` is accepted only if it is RIFF/WAVE PCM mono 8000 Hz 16-bit, with an actual parsed `data` chunk (not a presumed 44-byte header). The `parseAudioBytes` API returns 160-sample frames and duration, but does not transmit them.

The eventual AUDIO feature requires Web Serial at **230400 8N1** and an MCU firmware that explicitly advertises AUDIO V1. The ordinary UI continues to work with legacy firmware. UART `INFO baud=` is **CAN_BAUD**, not UART.

## Verification

```sh
cd upper
npm ci
npm run typecheck
npm run build:client
npm run test:audio
```

`test:audio` runs Node 22's TypeScript-strip mode. These are offline protocol/window tests, **not** certification that any connected motor is safe. A missing UART status, unexpected format, or loss of physical connection requires hardware emergency stop and power isolation; a browser tab close cannot guarantee even one outgoing byte.

## Serial writer

`SerialLink.writeBytes` uses the same single writer queue as `writeText`. It rejects packets above 334 bytes. `abortAudio` advances the cancellation generation and enqueues ABORT after the currently active write. This is a transport building block, **not** an end-to-end AUDIO shutdown routine. Normal Web Serial controls and PCAN remain unchanged.
