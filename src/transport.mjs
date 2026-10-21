// Keep the HTTP transport alive while Pi replaces the extension runtime.
// Only a short-lived, unguessable handoff reference is shared across module reloads.
export const handoffs = globalThis[Symbol.for('pi-web-ui.handoffs')] ??= new Map();

export function createTransport(bridge) {
  const listeners = new Set();
  let unsubscribe;
  const transport = {
    bridge, server: undefined, snapshot: undefined,
    notify() { for (const listener of listeners) listener(); },
    current() { return transport.snapshot ?? transport.bridge.current(); },
    execute(command) {
      if (transport.snapshot) throw Object.assign(new Error('Session change in progress.'), { status: 409 });
      return transport.bridge.execute(command);
    },
    listSessions() {
      if (transport.snapshot) throw Object.assign(new Error('Session change in progress.'), { status: 409 });
      return transport.bridge.listSessions();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attach(next) {
      unsubscribe?.();
      transport.bridge = next;
      transport.snapshot = undefined;
      unsubscribe = next.subscribe(() => transport.notify());
      transport.notify();
    },
    freeze() {
      transport.snapshot = { ...transport.bridge.current(), switching: true };
      transport.notify();
    },
    async close() { unsubscribe?.(); await transport.server?.close(); listeners.clear(); },
  };
  transport.attach(bridge);
  return transport;
}
