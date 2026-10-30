// In-app purchases: the request/answer protocol a StoreKit or Play Billing host speaks,
// and the mock store used on the web and in game tests.

import { expect, test } from "bun:test";
import { HostPurchases, MockPurchases } from "../src/platform/purchases.ts";
import { NativePlatform } from "../src/platform/native.ts";
import type { BlackironHostApi } from "../src/render/native.ts";
import { memoryBackend } from "../src/save/store.ts";

function storeHost(owned: string[] = []) {
  const requests: { id: number; op: string; arg: string }[] = [];
  const host = {
    now: () => 0,
    storageGet: () => null,
    storageSet: () => {},
    storageRemove: () => {},
    loadBytes: () => null,
    loadText: () => null,
    uploadTexture: () => {},
    submit: () => {},
    screen: { width: 800, height: 400, scale: 2, insets: [0, 0, 0, 0] as [number, number, number, number] },
    purchaseRequest: (id: number, op: string, arg: string) => requests.push({ id, op, arg }),
    purchaseOwned: () => JSON.stringify(owned),
  } satisfies BlackironHostApi;
  return { host, requests };
}

test("a host without a store exposes no purchases", () => {
  const { host } = storeHost();
  const bare: BlackironHostApi = { ...host, purchaseRequest: undefined, purchaseOwned: undefined };
  expect(new NativePlatform(bare).purchases).toBeUndefined();
  expect(new NativePlatform(host).purchases).toBeInstanceOf(HostPurchases);
});

test("products, buy and restore round-trip through request ids", async () => {
  const { host, requests } = storeHost(["old.item"]);
  const p = new HostPurchases(host);
  expect(p.owned()).toEqual(["old.item"]);
  const products = p.products(["full"]);
  const buy = p.buy("full");
  expect(requests.map((r) => r.op)).toEqual(["products", "buy"]);
  expect(JSON.parse(requests[0].arg)).toEqual(["full"]);
  // Answers may come back in any order.
  p.deliver(requests[1].id, JSON.stringify({ result: "purchased", owned: ["old.item", "full"] }));
  p.deliver(requests[0].id, JSON.stringify({ products: [{ id: "full", title: "Full", price: "4,99 €" }, { bogus: true }] }));
  expect(await buy).toBe("purchased");
  expect(await products).toEqual([{ id: "full", title: "Full", price: "4,99 €" }]);
  expect(p.owned()).toEqual(["old.item", "full"]);
  const restore = p.restore();
  p.deliver(requests[2].id, JSON.stringify({ owned: ["full"] }));
  expect(await restore).toEqual(["full"]);
});

test("unsolicited entitlement updates notify listeners; junk answers fail safely", async () => {
  const { host, requests } = storeHost();
  const p = new HostPurchases(host);
  const seen: string[][] = [];
  p.onChange((o) => seen.push(o));
  p.deliver(0, JSON.stringify({ owned: ["full"] }));
  p.deliver(0, JSON.stringify({ owned: ["full"] }));
  expect(seen).toEqual([["full"]]);
  const buy = p.buy("x");
  p.deliver(requests[0].id, "not json");
  expect(await buy).toBe("failed");
  const restore = p.restore();
  p.deliver(requests[1].id, JSON.stringify({ error: "network" }));
  await expect(restore).rejects.toThrow("network");
});

test("the mock store sells, remembers across reloads and can be told to cancel", async () => {
  const backend = memoryBackend();
  const m = new MockPurchases(backend);
  expect((await m.products(["full"]))[0].price).toBe("$4.99");
  m.next = "cancelled";
  expect(await m.buy("full")).toBe("cancelled");
  expect(m.owned()).toEqual([]);
  expect(await m.buy("full")).toBe("purchased");
  expect(await new MockPurchases(backend).restore()).toEqual(["full"]);
});
