// The shell↔sidecar USB bridge contract, sidecar side: usb-bridge.ts against the shared
// `app/src-tauri/contracts/shell-contracts.json`, which the shell's `usb/mod.rs` tests serialise
// against too. A field renamed on either side fails one of the two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { type UsbDeviceConnected, type UsbDeviceDisconnected, type UsbFrame, type UsbSend, parseUsbInbound } from "./usb-bridge.ts";

const contracts = JSON.parse(
  readFileSync(new URL("../../src-tauri/contracts/shell-contracts.json", import.meta.url), "utf8"),
) as { usbBridge: { toSidecar: Array<Record<string, unknown>>; toShell: Array<Record<string, unknown>> } };

type Keys<T> = Record<keyof T, true>;
const KEYS: Record<string, object> = {
  usbDeviceConnected: { type: true, mac: true, version: true } satisfies Keys<UsbDeviceConnected>,
  usbDeviceDisconnected: { type: true, mac: true } satisfies Keys<UsbDeviceDisconnected>,
  usbFrame: { type: true, mac: true, payloadHex: true } satisfies Keys<UsbFrame>,
  usbSend: { type: true, mac: true, payloadHex: true } satisfies Keys<UsbSend>,
};

for (const message of contracts.usbBridge.toSidecar) {
  test(`the shell's ${String(message["type"])} is a message the sidecar reads`, () => {
    const keys = KEYS[message["type"] as string];
    assert.ok(keys, `unknown type ${String(message["type"])}`);
    assert.deepEqual(Object.keys(message).sort(), Object.keys(keys).sort());
    assert.deepEqual(parseUsbInbound(JSON.stringify(message)), message);
  });
}

for (const message of contracts.usbBridge.toShell) {
  test(`the sidecar's ${String(message["type"])} has the fields the shell reads`, () => {
    assert.deepEqual(Object.keys(message).sort(), Object.keys(KEYS["usbSend"]!).sort());
    assert.equal(message["type"], "usbSend");
  });
}
