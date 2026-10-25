import { describe, expect, it, vi } from "vitest";
import { createBus } from "./bus";

interface Events {
  ping: { n: number };
  bare: undefined;
}

describe("createBus", () => {
  it("delivers payloads to every handler until they unsubscribe", () => {
    const bus = createBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on("ping", a);
    bus.on("ping", b);
    bus.emit("ping", { n: 1 });
    offA();
    bus.emit("ping", { n: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b.mock.calls).toEqual([[{ n: 1 }], [{ n: 2 }]]);
  });

  it("once handles a single event", () => {
    const bus = createBus<Events>();
    const fn = vi.fn();
    bus.once("bare", fn);
    bus.emit("bare");
    bus.emit("bare");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps going when a handler throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createBus<Events>();
    const after = vi.fn();
    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", after);
    bus.emit("ping", { n: 1 });
    expect(after).toHaveBeenCalled();
  });

  it("reports whether an event is handled", () => {
    const bus = createBus<Events>();
    expect(bus.handled("ping")).toBe(false);
    const off = bus.on("ping", () => {});
    expect(bus.handled("ping")).toBe(true);
    off();
    expect(bus.handled("ping")).toBe(false);
  });
});
