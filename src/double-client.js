import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { DoubleStore } from "./double-store.js";
import { SERVER_PROTOCOL } from "./paths.js";

const fail = (message) => { throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function configuration(env = process.env) {
  if (env.HUMAN_REVIEW_HOSTED === "1") fail("Double is not available in hosted mode.");
  const archiveDir = env.HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR;
  const stateDir = env.HUMAN_REVIEW_STATE_DIR;
  // Constructors validate paths only; neither path is accessed here.
  try { new DoubleStore({ archiveDir }); }
  catch { fail("Double requires an explicit canonical absolute HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR."); }
  try { new DoubleStore({ archiveDir: stateDir }); }
  catch { fail("Double requires an explicit canonical absolute HUMAN_REVIEW_STATE_DIR."); }
  if (stateDir === archiveDir || stateDir.startsWith(`${archiveDir}/`) || archiveDir.startsWith(`${stateDir}/`)) {
    fail("Double state and archive directories must be separate, not nested.");
  }
  return { archiveDir, stateDir };
}


export async function privatePath(file, directory) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (current !== file && !stat.isDirectory())) fail("Double state paths must not contain links.");
    if (current === file && ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || stat.uid !== process.getuid())) {
      fail("Double state directories require mode 0700, records mode 0600, and the current owner.");
    }
  }
}

export async function connectDoubleClient(config, { signal, sessions = false } = {}) {
  const server = await serverRecord(config.stateDir);
  const capability = await request(server, "/api/double/capabilities", { signal });
  if (capability.double !== 1 || capability.archiveId !== hash(config.archiveDir) || capability.recovery !== "authenticated-reopen") {
    fail("The existing server has incompatible Double support or a different archive. It was not replaced.");
  }
  if (sessions && capability.sessions !== 1) fail("The existing server has no compatible Double session support. It was not replaced.");
  return { server, capability };
}

export async function serverRecord(stateDir) {
  try {
    await privatePath(stateDir, true);
    const file = path.join(stateDir, "server.json");
    await privatePath(file, false);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (record.protocol !== SERVER_PROTOCOL || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
        typeof record.token !== "string" || !/^[a-f0-9]{32}$/.test(record.token)) throw new Error();
    return record;
  } catch { fail("No compatible private server record. Run Double serve in an unused disposable state directory; do not replace a running service."); }
}

export function request(server, route, { method = "GET", body, timeout = 10000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, path: route, method, signal,
      headers: { "x-human-review-token": server.token, "content-type": "application/json" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) res.destroy(new Error("Double response exceeds 64 MiB."));
        else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("Double response ended early. Retry mutations with the exact original request.")));
      res.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new Error("The server did not return a compatible Double JSON response.")); }
        if (res.statusCode !== 200) {
          // Do not echo arbitrary server text, paths, URLs, or credentials into diagnostics.
          const code = /^[A-Z_]+$/.test(value?.error?.code) ? value.error.code : `HTTP_${res.statusCode}`;
          return reject(new Error(`Double ${code}. Check the private server; retry mutations with the exact original request.`));
        }
        resolve(value);
      });
    });
    const timer = setTimeout(() => req.destroy(), timeout);
    req.once("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("The Double server is unavailable. No service was started or replaced. Retry mutations with the exact original request.")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
