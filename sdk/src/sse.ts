export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Parses a text/event-stream byte stream into messages (per the WHATWG EventSource rules). */
export async function* parseSse(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  function* lines(final: boolean): Generator<SseMessage> {
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buf);
      // A trailing "\r" may be the first half of "\r\n": wait for more input.
      if (!m || (m[0] === "\r" && m.index === buf.length - 1 && !final)) break;
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === "") {
        if (data.length) yield { event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  }

  for await (const chunk of iterate(body)) {
    buf += decoder.decode(chunk, { stream: true });
    yield* lines(false);
  }
  buf += decoder.decode();
  yield* lines(true);
}

async function* iterate(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (!("getReader" in body)) {
    yield* body;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Cancelling (rather than just releasing the lock) closes the underlying connection.
    await reader.cancel().catch(() => {});
  }
}
