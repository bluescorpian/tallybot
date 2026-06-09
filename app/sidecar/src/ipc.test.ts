import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type AppState,
  type SidecarEvent,
  type UiCommand,
  parseCommand,
  parseEvent,
  serializeMessage,
} from "./ipc.ts";

const sampleState: AppState = {
  source: { kind: "atem", ip: "192.168.1.50", connection: "connected" },
  inputs: [
    { id: 1, label: "Camera 1", tally: "live" },
    { id: 2, label: "Camera 2", tally: "preview" },
  ],
  devices: [
    {
      mac: "aa:bb:cc:dd:ee:ff",
      macTail: "dd:ee:ff",
      state: "assigned",
      inputId: 1,
      brightness: 128,
      protocolVersion: 1,
      firmwareOutdated: false,
      transport: "wifi",
      wifiState: null,
      rssi: null,
    },
  ],
  programGate: { active: false, source: null },
};

test("serializeMessage produces a single NDJSON line", () => {
  const line = serializeMessage({ type: "notice", level: "warn", message: "x" });
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1); // exactly one, at the end
});

test("event round-trips through serialize → parse", () => {
  const event: SidecarEvent = { type: "state", state: sampleState };
  const parsed = parseEvent(serializeMessage(event));
  assert.deepEqual(parsed, event);
});

test("command round-trips through serialize → parse", () => {
  const command: UiCommand = { type: "assignDevice", mac: "aa:bb:cc:dd:ee:ff", inputId: 2 };
  const parsed = parseCommand(serializeMessage(command));
  assert.deepEqual(parsed, command);
});

test("parsers reject unknown message types", () => {
  assert.equal(parseEvent(JSON.stringify({ type: "bogus" })), null);
  assert.equal(parseCommand(JSON.stringify({ type: "bogus" })), null);
});

test("parsers reject the other direction's messages", () => {
  // A command is not an event, and vice versa.
  assert.equal(parseEvent(serializeMessage({ type: "unassignDevice", mac: "x" })), null);
  assert.equal(parseCommand(serializeMessage({ type: "notice", level: "info", message: "x" })), null);
});

test("parsers reject malformed JSON and non-objects", () => {
  assert.equal(parseEvent("{not json"), null);
  assert.equal(parseCommand("not json"), null);
  assert.equal(parseEvent("42"), null);
  assert.equal(parseCommand("null"), null);
});
