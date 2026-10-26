import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encodeDoubleComparisonId } from "./double-route.js";
import { assertPosixOnly } from "./posix-only.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const MAX_OUTPUT = 64 * 1024 * 1024;

// Keep authentication and private-path checks in the existing CLI. Never put a
// credential on argv or return child diagnostics to a chat.
export function createDoubleChatClient(env = process.env) {
  assertPosixOnly(); // The child CLI would refuse too, but its diagnostics never reach the chat.
  const childEnv = { ...env };
  const archive = childEnv.HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR;
  if (!archive || !childEnv.HUMAN_REVIEW_STATE_DIR) throw new Error("Double requires explicit state and archive paths.");
  const archiveId = createHash("sha256").update(archive).digest("hex");

  function run(args, signal, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Double request cancelled."));
      const child = spawn(process.execPath, [cli, "double", ...args], {
        env: childEnv, stdio: ["ignore", "pipe", "pipe"], shell: false,
      });
      let bytes = 0;
      const chunks = [];
      let failed = false;
      let killTimer;
      const stop = () => {
        failed = true;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      };
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", stop);
      };
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) stop();
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.once("error", () => { cleanup(); reject(new Error("Double client could not start.")); });
      child.once("close", (code) => {
        cleanup();
        if (failed || code !== 0) return reject(new Error("Double request failed or disconnected; the archive remains retrievable."));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Double returned invalid JSON.")); }
      });
    });
  }

  return {
    archiveId,
    status(id, signal) {
      encodeDoubleComparisonId(id);
      return run(["status", id], signal);
    },
    poll(id, seconds, signal) {
      encodeDoubleComparisonId(id);
      return run(["poll", id, "--timeout", String(seconds)], signal, seconds * 1000 + 25000);
    },
    acknowledge(id, batchId, actionId, signal) {
      for (const value of [id, batchId, actionId]) encodeDoubleComparisonId(value);
      return run(["ack", id, batchId, "--action-id", actionId], signal);
    },
  };
}
