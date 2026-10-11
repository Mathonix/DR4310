/** Serial parameter transactions. A scope is reused by nested writes/saves. */
export type TelemetryScope = {
  restore(): Promise<void>;
  setRestoreValue(value: number): void;
};
export function createTelemetryTransactions(h: {
  current(): number | null;
  run(line: string): Promise<{ ok: boolean; err?: string }>;
  restored(value: number): void;
  /** Capture the connection at enqueue time so an old operation cannot affect a reconnected device. */
  captureSession?(): () => boolean;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  async function execute<T>(operation: (scope: TelemetryScope) => Promise<T>, currentSession: () => boolean): Promise<T> {
    if (!currentSession()) throw new Error("串口连接已变更，取消参数操作");
    let value = h.current();
    let pending = value !== null && Number.isFinite(value) && value !== 0;
    const scope: TelemetryScope = {
      async restore() {
        if (!pending) return;
        if (!currentSession()) throw new Error("串口连接已变更，未恢复遥测");
        const r = await h.run(`SET TELEM ${value}\n`);
        if (!r.ok) throw new Error(r.err || "恢复遥测失败，未保存配置");
        pending = false;
        h.restored(value!);
      },
      setRestoreValue(next) { value = next; },
    };
    try {
      if (pending) {
        const r = await h.run("SET TELEM 0\n");
        if (!r.ok) throw new Error(r.err || "暂停遥测失败");
      }
      if (!currentSession()) throw new Error("串口连接已变更，取消参数操作");
      return await operation(scope);
    } finally {
      // Even a lost pause acknowledgement may have changed the device. Retry
      // restoration after a failed pre-SAVE restore; never SAVE in finally.
      await scope.restore();
    }
  }
  return function withTelemetryPaused<T>(operation: (scope: TelemetryScope) => Promise<T>, scope?: TelemetryScope): Promise<T> {
    if (scope) return operation(scope);
    const currentSession = h.captureSession?.() ?? (() => true);
    const result = tail.then(() => execute(operation, currentSession));
    tail = result.catch(() => {});
    return result;
  };
}
