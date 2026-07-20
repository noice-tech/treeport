import { describe, expect, it } from "vitest";
import {
  controlAttachArgs,
  decodeTmuxControlBytes,
  encodeControlInput,
  resizeControlClient,
  setControlPanePaused,
  setControlPauseAfter,
  TmuxControlParser,
  TmuxControlProtocolError,
} from "./tmux-control.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const output = (events: ReturnType<TmuxControlParser["push"]>) => {
  const event = events.find((candidate) => candidate.type === "output");
  if (!event || event.type !== "output") throw new Error("missing output event");
  return event;
};

describe("TmuxControlParser", () => {
  it("decodes control bytes, backslash, UTF-8, OSC 8, NUL, and 0xff exactly", () => {
    const encoded = Buffer.concat([
      Buffer.from("A\\033]8;;https://example.test\\007link\\033]8;;\\007"),
      Buffer.from("\\015\\012\\134\\000"),
      Buffer.from("☃", "utf8"),
      Buffer.from([0xff]),
    ]);
    expect(decodeTmuxControlBytes(encoded)).toEqual(
      Uint8Array.from(
        Buffer.concat([
          Buffer.from("A\x1b]8;;https://example.test\x07link\x1b]8;;\x07\r\n\\\0"),
          Buffer.from("☃", "utf8"),
          Buffer.from([0xff]),
        ]),
      ),
    );
  });

  it("handles fragmented and multiple records without converting pane bytes to text", () => {
    const parser = new TmuxControlParser();
    expect(parser.push(Buffer.from("%out"))).toEqual([]);
    expect(parser.push(Buffer.from("put %2 one\\015"))).toEqual([]);
    const events = parser.push(Buffer.from("\\012\n%output %2 two\\134three\n"));
    expect(events).toHaveLength(2);
    expect(output(events).data).toEqual(Uint8Array.from(Buffer.from("one\r\n")));
    const second = events[1];
    expect(second?.type).toBe("output");
    if (second?.type === "output")
      expect(second.data).toEqual(Uint8Array.from(Buffer.from("two\\three")));
    parser.finish();
  });

  it("isolates command responses even when their lines resemble notifications", () => {
    const parser = new TmuxControlParser();
    const events = parser.push(
      Buffer.from(
        "%begin 100 7 1\n%output %9 this-is-command-text\nordinary output\n%end 100 7 1\n%output %9 pane\\012\n",
      ),
    );
    expect(events).toHaveLength(2);
    const command = events[0];
    expect(command?.type).toBe("command");
    if (command?.type === "command") {
      expect(command.success).toBe(true);
      expect(command.lines.map((line) => Buffer.from(line).toString())).toEqual([
        "%output %9 this-is-command-text",
        "ordinary output",
      ]);
    }
    expect(output(events).data).toEqual(Uint8Array.from(Buffer.from("pane\n")));
  });

  it("parses failed commands, extended output, flow events, exit, and notifications", () => {
    const parser = new TmuxControlParser();
    const events = parser.push(
      Buffer.from(
        "%begin 101 8 1\nunknown command\n%error 101 8 1\n" +
          "%extended-output %3 1234 future-field : hi\\000\\377\n" +
          "%pause %3\n%continue %3\n%window-add snow☃\n%exit detached☃\n",
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "command",
      "output",
      "pause",
      "continue",
      "notification",
      "exit",
    ]);
    const extended = events[1];
    if (extended?.type !== "output") throw new Error("missing extended output");
    expect(extended.lagMs).toBe(1234);
    expect(extended.data).toEqual(bytes(0x68, 0x69, 0x00, 0xff));
    expect(events[4]).toEqual({ type: "notification", name: "window-add", arguments: "snow☃" });
    expect(events[5]).toEqual({ type: "exit", reason: "detached☃" });
  });

  it("fails closed on malformed escapes, guards, unexpected data, and oversized records", () => {
    for (const line of [
      "%output %1 bad\\x00\n",
      "%output %1 bad\\400\n",
      "%begin 1 2 1\n%end 1 3 1\n",
      "%begin 1 2 1\n%end 1 2 9\n",
      "%end 1 2 1\n",
      "not-control\n",
    ]) {
      const parser = new TmuxControlParser();
      expect(() => parser.push(Buffer.from(line))).toThrow(TmuxControlProtocolError);
      expect(() => parser.push(Buffer.from("%sessions-changed\n"))).toThrow(/failed state/);
    }
    const limited = new TmuxControlParser(8);
    expect(() => limited.push(Buffer.from("%output %1 too long"))).toThrow(/size limit/);
  });

  it("bounds complete command responses and rejects unfinished streams", () => {
    const oversized = new TmuxControlParser(16);
    expect(() => oversized.push(Buffer.from("%begin 1 2 1\n1234567890\n1234567\n"))).toThrow(
      /Command response/,
    );

    const parser = new TmuxControlParser();
    parser.push(Buffer.from("%begin 1 2 1\nline\n"));
    expect(() => parser.finish()).toThrow(/Incomplete/);
  });
});

describe("tmux control commands", () => {
  it("builds a non-default control attachment", () => {
    expect(controlAttachArgs("socket", "/runtime/tmux.conf", "session")).toEqual([
      "-L",
      "socket",
      "-f",
      "/runtime/tmux.conf",
      "-C",
      "attach-session",
      "-t",
      "session",
    ]);
  });

  it("encodes arbitrary bytes as bounded hexadecimal arguments", () => {
    expect(encodeControlInput("%12", bytes(0, 0x1b, 0x5c, 0xff, 0xe2), 2)).toEqual([
      "send-keys -H -t %12 00 1b\n",
      "send-keys -H -t %12 5c ff\n",
      "send-keys -H -t %12 e2\n",
    ]);
    expect(() => encodeControlInput("%1; kill-server", bytes(1))).toThrow(/pane ID/);
    expect(() => encodeControlInput("%1", bytes(1), 0)).toThrow(/chunkBytes/);
  });

  it("validates resize and flow-control commands", () => {
    expect(resizeControlClient(120, 40)).toBe("refresh-client -C 120x40\n");
    expect(() => resizeControlClient(0, 40)).toThrow(/dimensions/);
    expect(() => resizeControlClient(80.5, 40)).toThrow(/dimensions/);
    expect(setControlPanePaused("%7", true)).toBe("refresh-client -A '%7:pause'\n");
    expect(setControlPanePaused("%7", false)).toBe("refresh-client -A '%7:continue'\n");
    expect(setControlPauseAfter(30)).toBe("refresh-client -f pause-after=30\n");
    expect(() => setControlPauseAfter(-1)).toThrow(/pause-after/);
  });
});
