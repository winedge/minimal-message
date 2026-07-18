type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  static defaultMaxListeners = 10;

  private events = new Map<string | symbol, Listener[]>();
  private maxListeners = EventEmitter.defaultMaxListeners;

  setMaxListeners(n: number) {
    this.maxListeners = n;
    return this;
  }

  getMaxListeners() {
    return this.maxListeners;
  }

  on(eventName: string | symbol, listener: Listener) {
    return this.addListener(eventName, listener);
  }

  addListener(eventName: string | symbol, listener: Listener) {
    const listeners = this.events.get(eventName) ?? [];
    listeners.push(listener);
    this.events.set(eventName, listeners);
    return this;
  }

  prependListener(eventName: string | symbol, listener: Listener) {
    const listeners = this.events.get(eventName) ?? [];
    listeners.unshift(listener);
    this.events.set(eventName, listeners);
    return this;
  }

  once(eventName: string | symbol, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.removeListener(eventName, wrapped);
      listener(...args);
    };
    Object.defineProperty(wrapped, "listener", { value: listener });
    return this.addListener(eventName, wrapped);
  }

  off(eventName: string | symbol, listener: Listener) {
    return this.removeListener(eventName, listener);
  }

  removeListener(eventName: string | symbol, listener: Listener) {
    const listeners = this.events.get(eventName);
    if (!listeners) return this;
    const next = listeners.filter(
      (candidate) => candidate !== listener && (candidate as Listener & { listener?: Listener }).listener !== listener,
    );
    if (next.length) this.events.set(eventName, next);
    else this.events.delete(eventName);
    return this;
  }

  removeAllListeners(eventName?: string | symbol) {
    if (eventName === undefined) this.events.clear();
    else this.events.delete(eventName);
    return this;
  }

  emit(eventName: string | symbol, ...args: unknown[]) {
    const listeners = this.events.get(eventName);
    if (!listeners?.length) return false;
    [...listeners].forEach((listener) => listener(...args));
    return true;
  }

  listeners(eventName: string | symbol) {
    return [...(this.events.get(eventName) ?? [])];
  }

  rawListeners(eventName: string | symbol) {
    return this.listeners(eventName);
  }

  listenerCount(eventName: string | symbol) {
    return this.events.get(eventName)?.length ?? 0;
  }
}

export default { EventEmitter };