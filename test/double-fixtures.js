import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function fixture(t, comparisonId = "trial") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "double-integration-"));
  // After hooks run in registration order, so this one runs before later hooks such as listen() close.
  // A server request still running during the removal can recreate the archive. Close servers first.
  const beforeRemove = [];
  t.after(async () => {
    for (const close of beforeRemove.reverse()) await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const archiveDir = path.join(root, "archive");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  const manifest = { comparisonId, label: "Two proposals", panes: {} };
  const hashes = new Map();
  for (const pane of ["left", "right"]) {
    const originalRoot = path.join(root, `original-${pane}`);
    const copyRoot = path.join(root, `copy-${pane}`);
    for (const dir of [originalRoot, copyRoot]) await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    const files = {
      "index.html": `<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><section data-double-id="hero" data-container="Hero"><h1>${pane} copy</h1><img src="assets/image.png" alt="Preview"></section><footer data-double-id="footer" data-container="Footer">End</footer></body></html>`,
      "assets/site.css": 'section { background: url("image.png"); color: black; }',
      "assets/image.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO9sAAAAASUVORK5CYII=", "base64"),
    };
    const originalFiles = [];
    for (const [name, bytes] of Object.entries(files)) {
      const original = path.join(originalRoot, name);
      await fs.writeFile(original, bytes);
      await fs.writeFile(path.join(copyRoot, name), bytes);
      for (const full of [original, path.join(copyRoot, name)]) hashes.set(full, digest(bytes));
      originalFiles.push({ path: original, sha256: digest(bytes) });
    }
    manifest.panes[pane] = {
      label: `Proposal ${pane}`, original: { entry: path.join(originalRoot, "index.html"), files: originalFiles },
      copy: { root: copyRoot, entry: "index.html", assets: ["assets/site.css", "assets/image.png"] },
    };
  }
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return {
    root, archiveDir, stateDir, manifest, manifestPath, hashes, beforeRemove,
    record: path.join(archiveDir, `double-${digest(comparisonId)}.json`),
    async unchanged(assert) {
      for (const [file, baseline] of hashes) assert.equal(digest(await fs.readFile(file)), baseline, "a source or review-copy hash changed");
    },
  };
}

export function request(port, route, { token, method = "GET", body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: {
      ...(token ? { "x-human-review-token": token } : {}),
      ...(body !== undefined || rawBody !== undefined ? { "content-type": "application/json" } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on("data", (bytes) => chunks.push(bytes));
      res.on("error", reject);
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, bytes, text, json });
      });
    });
    req.on("error", reject);
    req.end(rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

export async function listen(t, f, env = {}) {
  const previous = Object.fromEntries(["HUMAN_REVIEW_STATE_DIR", "HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR", "HUMAN_REVIEW_HOSTED"].map((key) => [key, process.env[key]]));
  process.env.HUMAN_REVIEW_STATE_DIR = f.stateDir;
  process.env.HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR = f.archiveDir;
  delete process.env.HUMAN_REVIEW_HOSTED;
  Object.assign(process.env, env);
  const { createServer } = await import("../src/server.js");
  const service = createServer();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  // Track each request handler; a closed connection does not end a handler that is still writing.
  const handling = new Set();
  const [handler] = service.server.listeners("request");
  service.server.removeListener("request", handler);
  service.server.on("request", (req, res) => {
    const work = Promise.allSettled([handler(req, res)]);
    handling.add(work);
    work.then(() => handling.delete(work));
  });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const port = service.server.address().port;
  let closed;
  const close = () => closed ??= (async () => {
    service.dispose();
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
    await Promise.all(handling);
  })();
  t.after(close);
  f.beforeRemove?.push(close);
  return { ...service, port, close, api: (route, options = {}) => request(port, route, { token: service.token, ...options }) };
}
