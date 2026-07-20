import { describe, expect, it } from "vitest";
import { StreamParser } from "./stream-parser.js";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

describe("StreamParser — LF and CRLF", () => {
  it("parses LF-delimited lines", () => {
    const parser = new StreamParser();
    const outcomes = parser.push(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }) +
        "\n" +
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "b" }] } }) +
        "\n",
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toEqual({ kind: "messages", messages: [{ kind: "text", text: "a" }] });
    expect(outcomes[1]).toEqual({ kind: "messages", messages: [{ kind: "text", text: "b" }] });
  });

  it("parses CRLF-delimited lines, stripping the trailing carriage return", () => {
    const parser = new StreamParser();
    const outcomes = parser.push(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }) +
        "\r\n",
    );
    expect(outcomes).toEqual([{ kind: "messages", messages: [{ kind: "text", text: "a" }] }]);
  });
});

describe("StreamParser — chunk boundaries", () => {
  it("handles a line split across multiple push() calls", () => {
    const parser = new StreamParser();
    const full = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });
    const first = parser.push(full.slice(0, 10));
    expect(first).toEqual([]);
    const second = parser.push(full.slice(10) + "\n");
    expect(second).toEqual([{ kind: "messages", messages: [{ kind: "text", text: "hello" }] }]);
  });

  it("handles multiple complete lines delivered in one chunk", () => {
    const parser = new StreamParser();
    const outcomes = parser.push(
      line({ type: "rate_limit_event" }) +
        line({ type: "rate_limit_event" }) +
        line({ type: "rate_limit_event" }),
    );
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.kind === "messages")).toBe(true);
  });

  it("ignores blank lines between JSON objects", () => {
    const parser = new StreamParser();
    const outcomes = parser.push("\n\n" + line({ type: "rate_limit_event" }) + "\n");
    expect(outcomes).toHaveLength(1);
  });
});

describe("StreamParser — malformed and invalid input", () => {
  it("reports malformed JSON without aborting the rest of the stream", () => {
    const parser = new StreamParser();
    const outcomes = parser.push("{not valid json\n" + line({ type: "rate_limit_event" }));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.kind).toBe("malformed-json");
    expect(outcomes[1]?.kind).toBe("messages");
  });

  it("bounds the malformed-json snippet length", () => {
    const parser = new StreamParser();
    const outcomes = parser.push("{" + "x".repeat(5000) + "\n");
    expect(outcomes[0]?.kind).toBe("malformed-json");
    if (outcomes[0]?.kind === "malformed-json") {
      expect(outcomes[0].snippet.length).toBeLessThanOrEqual(100);
    }
  });

  it("reports an invalid line (valid JSON, wrong shape) without aborting the rest of the stream", () => {
    const parser = new StreamParser();
    const outcomes = parser.push(
      line({ type: "result", subtype: "success" }) + line({ type: "rate_limit_event" }),
    );
    expect(outcomes[0]?.kind).toBe("invalid-line");
    expect(outcomes[1]?.kind).toBe("messages");
  });
});

describe("StreamParser — oversized line", () => {
  it("reports oversized-line for a line exceeding the configured bound", () => {
    const parser = new StreamParser({ maxLineLength: 50 });
    const outcomes = parser.push(
      line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(200) }] } }),
    );
    expect(outcomes).toEqual([{ kind: "oversized-line" }]);
  });

  it("continues parsing subsequent lines after an oversized one", () => {
    const parser = new StreamParser({ maxLineLength: 50 });
    const outcomes = parser.push(
      line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(200) }] } }) +
        line({ type: "rate_limit_event" }),
    );
    expect(outcomes[0]?.kind).toBe("oversized-line");
    expect(outcomes[1]?.kind).toBe("messages");
  });

  it("reports oversized-line for a single push() that exceeds the bound with no newline at all", () => {
    // Regression test: a chunk with no "\n" never reaches #processLine's
    // per-line length check, so without a buffer-level bound this would
    // grow #buffer unboundedly across repeated push() calls instead of
    // failing safely.
    const parser = new StreamParser({ maxLineLength: 50 });
    const outcomes = parser.push("x".repeat(200));
    expect(outcomes).toEqual([{ kind: "oversized-line" }]);
  });

  it("reports oversized-line once the partial buffer exceeds the bound across multiple push() calls with no newline", () => {
    const parser = new StreamParser({ maxLineLength: 50 });
    const first = parser.push("x".repeat(30));
    expect(first).toEqual([]);
    const second = parser.push("x".repeat(30));
    expect(second).toEqual([{ kind: "oversized-line" }]);
  });

  it("resets the buffer after a no-newline overflow so a subsequent valid line still parses", () => {
    const parser = new StreamParser({ maxLineLength: 50 });
    parser.push("x".repeat(200));
    const outcomes = parser.push(line({ type: "rate_limit_event" }));
    expect(outcomes).toEqual([{ kind: "messages", messages: [{ kind: "ignored" }] }]);
  });
});

describe("StreamParser — truncated final line", () => {
  it("reports no truncation when the stream ends cleanly on a newline", () => {
    const parser = new StreamParser();
    parser.push(line({ type: "rate_limit_event" }));
    expect(parser.flush()).toEqual([]);
  });

  it("reports a truncated final line when the stream ends mid-line", () => {
    const parser = new StreamParser();
    parser.push('{"type":"assistant","message":{"content":[');
    expect(parser.flush()).toEqual([{ kind: "truncated-final-line" }]);
  });

  it("does not report truncation for a buffer that is only trailing whitespace", () => {
    const parser = new StreamParser();
    parser.push(line({ type: "rate_limit_event" }) + "   ");
    expect(parser.flush()).toEqual([]);
  });
});

describe("StreamParser — bounded message count", () => {
  it("stops processing after maxMessages lines and reports message-limit-reached", () => {
    const parser = new StreamParser({ maxMessages: 3 });
    const outcomes = parser.push(
      line({ type: "rate_limit_event" }) +
        line({ type: "rate_limit_event" }) +
        line({ type: "rate_limit_event" }) +
        line({ type: "rate_limit_event" }) +
        line({ type: "rate_limit_event" }),
    );
    expect(outcomes).toHaveLength(5);
    expect(outcomes.slice(0, 3).every((o) => o.kind === "messages")).toBe(true);
    expect(outcomes[3]).toEqual({ kind: "message-limit-reached" });
    expect(outcomes[4]).toEqual({ kind: "message-limit-reached" });
  });

  it("continues reporting message-limit-reached on later push() calls once the limit is hit", () => {
    const parser = new StreamParser({ maxMessages: 1 });
    parser.push(line({ type: "rate_limit_event" }) + line({ type: "rate_limit_event" }));
    const later = parser.push(line({ type: "rate_limit_event" }));
    expect(later).toEqual([{ kind: "message-limit-reached" }]);
  });

  it("does not count blank lines toward the message limit", () => {
    const parser = new StreamParser({ maxMessages: 1 });
    const outcomes = parser.push("\n\n" + line({ type: "rate_limit_event" }));
    expect(outcomes).toEqual([{ kind: "messages", messages: [{ kind: "ignored" }] }]);
  });

  it("exposes processedLineCount", () => {
    const parser = new StreamParser();
    parser.push(line({ type: "rate_limit_event" }) + line({ type: "rate_limit_event" }));
    expect(parser.processedLineCount).toBe(2);
  });
});

describe("StreamParser — ordering", () => {
  it("preserves provider ordering across many lines", () => {
    const parser = new StreamParser();
    const texts = ["one", "two", "three", "four"];
    const chunk = texts
      .map((text) => line({ type: "assistant", message: { content: [{ type: "text", text }] } }))
      .join("");
    const outcomes = parser.push(chunk);
    const orderedTexts = outcomes.flatMap((o) => (o.kind === "messages" ? o.messages : []));
    expect(orderedTexts).toEqual(texts.map((text) => ({ kind: "text", text })));
  });
});
