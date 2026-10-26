import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function request(server, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: route,
        headers: { "x-human-review-token": server.token || "", ...(body ? { "content-type": "application/json" } : {}), ...headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: raw.trim() ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** The checkout CLI against one disposable state directory. */
export function cli(stateDir, args) {
  const child = spawn(process.execPath, ["src/cli.js", ...args], {
    cwd: project,
    env: { ...process.env, HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_NO_BROWSER: "1", HUMAN_REVIEW_HOSTED: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr, json: parse(stdout) }));
  });
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** A detached review server on a disposable state directory; `restart` replaces it on the same state. */
export async function disposableServer(t, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walkr-core-wake-"));
  const stateDir = path.join(tmp, "state");
  const fixture = { tmp, stateDir, server: null, child: null };
  async function launch() {
    fs.rmSync(path.join(stateDir, "server.json"), { force: true });
    fixture.child = spawn(process.execPath, ["src/server-entry.js"], {
      cwd: project,
      env: { ...process.env, HUMAN_REVIEW_STATE_DIR: stateDir, HUMAN_REVIEW_HOSTED: "", ...env },
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "server.json"), "utf8"));
        const health = await new Promise((resolve, reject) =>
          http.get({ host: "127.0.0.1", port: saved.port, path: "/health" }, (res) => {
            res.resume();
            resolve(res.statusCode);
          }).on("error", reject)
        );
        if (health === 200 && saved.pid === fixture.child.pid) {
          fixture.server = saved;
          return fixture;
        }
      } catch {
        // The child has not announced its port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("review server did not start");
  }
  fixture.stop = async () => {
    const child = fixture.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  };
  fixture.restart = async () => {
    await fixture.stop();
    return launch();
  };
  t.after(async () => {
    await fixture.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return launch();
}

/** The first agent event that the page's stream reports. */
export function agentEvent(server, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: server.port, path: `/events/${sessionId}`, headers: { "x-human-review-token": server.token } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        const found = raw.match(/event: agent\ndata: (.*)\n\n/);
        if (!found) return;
        req.destroy();
        resolve(JSON.parse(found[1]));
      });
    });
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
  });
}

/** An open review of one HTML file with a comment helper and a Send helper. */
export async function openReview(fixture, name = "review.html") {
  const file = path.join(fixture.tmp, name);
  fs.writeFileSync(file, "<p>Original words here</p>");
  const opened = (await request(fixture.server, "POST", "/api/session", { file })).body;
  const review = {
    ...opened,
    target: fs.realpathSync(file),
    comment: (feedback) => request(fixture.server, "POST", `/api/page/${opened.key}/comment`, { kind: "selection", quote: "words", feedback }),
    send: (note = "") => request(fixture.server, "POST", `/api/page/${opened.key}/send`, { sessionId: opened.sessionId, note }),
    feedback: async () => (await request(fixture.server, "GET", `/api/page/${opened.key}?session=${opened.sessionId}`)).body.comments.map((c) => c.feedback),
  };
  return review;
}
