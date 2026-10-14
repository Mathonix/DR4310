import { SerialPortTransport } from "./serial-port";
import { AudioSession } from "./audio";
type Command =
  | { method: "open"; args: { selected: SerialPortInfo; baud: number } }
  | { method: "audioOpen"; args: { axis: "Q" | "D"; amplitude: number } }
  | { method: "write" | "audioPlay"; args: Uint8Array }
  | { method: "cancel" | "close" | "audioCancel" | "audioExit" | "audioPause" | "audioResume"; args?: never };

const transport = new SerialPortTransport();
let audio: AudioSession | null = null;
const sleepers = new Set<() => void>();
const wake = () => { for (const finish of [...sleepers]) finish(); };
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); sleepers.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms); sleepers.add(finish);
  });
}
const post = (message: unknown) => (self as unknown as { postMessage(value: unknown): void }).postMessage(message);
let publishedAt = -Infinity, publishedSid = 0, publishedState = -1, publishedBinary = false;
function publish(): void {
  if (!audio) return;
  const now = performance.now(), state = audio.status?.state ?? -1;
  if (now - publishedAt < 40 && audio.sid === publishedSid && state === publishedState && audio.binary === publishedBinary) return;
  publishedAt = now; publishedSid = audio.sid; publishedState = state; publishedBinary = audio.binary;
  post({ event: "audio", state: { status: audio.status, sid: audio.sid, binary: audio.binary, retries: audio.retries, rejected: audio.parser.rejected, capacity: audio.capacity, window: audio.window } });
}
transport.onData = bytes => { if (audio?.binary) audio.receive(bytes); else post({ event: "data", bytes }); wake(); };
transport.onClose = reason => { audio?.cancel(); wake(); post({ event: "closed", reason }); };
async function handle(command: Command): Promise<unknown> {
  switch (command.method) {
    case "open": {
      if (!("serial" in navigator)) throw new Error("浏览器不支持后台串口，请更新 Chrome / Edge");
      const matches = (await navigator.serial.getPorts()).filter(port => JSON.stringify(port.getInfo()) === JSON.stringify(command.args.selected));
      if (matches.length !== 1) throw new Error("无法唯一识别串口，请撤销其他相同适配器的授权后重试");
      await transport.openPort(matches[0]!, command.args.baud); return;
    }
    case "write": if (audio?.binary) throw new Error("音频独占串口"); await transport.writeBytes(new Uint8Array(command.args)); return;
    case "cancel": transport.cancelPending(); return;
    case "close": await audio?.exit(); await transport.close(); return;
    case "audioOpen": {
      if (audio?.binary) throw new Error("音频会话尚未退出");
      audio = new AudioSession({ write: bytes => transport.writeBytes(bytes), cancel: () => { transport.cancelPending(); wake(); }, connected: () => transport.connected, now: () => performance.now(), sleep, changed: publish });
      await audio.open(command.args.axis, command.args.amplitude); publish(); return;
    }
    case "audioPlay": {
      if (!audio) throw new Error("音频尚未打开");
      // Complete binary cleanup in the worker even if the page is suspended.
      try { await audio.play(new Uint8Array(command.args)); }
      finally { await audio.exit(); publish(); }
      return;
    }
    case "audioCancel": audio?.cancel(); return;
    case "audioExit": { const exited = await audio?.exit() ?? true; publish(); return exited; }
    case "audioPause": await audio?.pause(); return;
    case "audioResume": await audio?.resume(); return;
    default: throw new Error("未知串口操作");
  }
}
self.addEventListener("message", (event: MessageEvent<Command & { id: number }>) => {
  const { id } = event.data;
  void handle(event.data).then(value => post({ id, value }), e => post({ id, error: e instanceof Error ? e.message : String(e) }));
});
