import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { IpcBridge } from "./ipc-bridge.ts";
import { type SidecarEvent, type UiCommand, parseEvent, serializeMessage } from "./ipc.ts";

function makeBridge(): { bridge: IpcBridge; input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  return { bridge: new IpcBridge({ input, output }), input, output };
}

test("a command line on stdin is parsed and surfaced", async () => {
  const { bridge, input } = makeBridge();
  const got = once(bridge, "command");
  const command: UiCommand = { type: "assignDevice", mac: "aa:bb:cc:dd:ee:ff", inputId: 2 };
  input.write(serializeMessage(command));
  const [received] = (await got) as [UiCommand];
  assert.deepEqual(received, command);
});

test("blank and unrecognised lines are ignored", async () => {
  const { bridge, input } = makeBridge();
  let commands = 0;
  bridge.on("command", () => {
    commands++;
  });
  input.write("\n");
  input.write("not json\n");
  input.write(`${JSON.stringify({ type: "bogus" })}\n`);
  // Give the readline loop a tick to process the lines above.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands, 0);
});

test("send writes one NDJSON line that parses back to the event", async () => {
  const { bridge, output } = makeBridge();
  const line = once(output, "data");
  const event: SidecarEvent = {
    type: "state",
    state: {
      source: { kind: "atem", ip: null, connection: "disconnected" },
      inputs: [],
      devices: [],
      programGate: { active: false, source: null },
    },
  };
  bridge.send(event);
  const [chunk] = (await line) as [Buffer];
  const text = chunk.toString("utf8");
  assert.ok(text.endsWith("\n"), "events are newline-terminated");
  assert.deepEqual(parseEvent(text), event);
});

test("notice emits a typed notice event", async () => {
  const { bridge, output } = makeBridge();
  const line = once(output, "data");
  bridge.notice("warn", "update firmware");
  const [chunk] = (await line) as [Buffer];
  assert.deepEqual(parseEvent(chunk.toString("utf8")), {
    type: "notice",
    level: "warn",
    message: "update firmware",
  });
});
