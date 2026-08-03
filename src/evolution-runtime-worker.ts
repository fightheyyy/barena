import type { Readable, Writable } from "node:stream";
import { executeEvolutionRuntimeRequest } from "./evolution-runtime";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export async function runEvolutionRuntimeWorker(input: {
  stdin?: Readable;
  stdout?: Writable;
} = {}): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedStream(stdin));
    } catch (error) {
      parsed = {
        invalid_json: error instanceof Error ? error.message : "invalid JSON",
      };
    }
    const response = await executeEvolutionRuntimeRequest(parsed, {
      signal: abort.signal,
    });
    await writeLine(stdout, JSON.stringify(response));
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

async function readBoundedStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Evolution Runtime request is too large");
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (!source) throw new Error("Evolution Runtime worker stdin is empty");
  return source;
}

function writeLine(stream: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

if (require.main === module) {
  void runEvolutionRuntimeWorker().catch(() => {
    process.exitCode = 1;
  });
}
