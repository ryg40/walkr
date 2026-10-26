import fs from "node:fs/promises";
import path from "node:path";
import { digest, request } from "./double-fixtures.js";
import { encodeDoubleComparisonId } from "../src/double-route.js";

export const croute = (id) => `/api/double/modes/coinflip/sessions/${encodeDoubleComparisonId(id)}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO9sAAAAASUVORK5CYII=", "base64");

// The GUI browser credential from the private GUI page; owner decisions require it.
export async function browserToken(port, guiPath) {
  return /data-token="([0-9a-f]{64})"/.exec((await request(port, new URL(guiPath, "http://127.0.0.1").pathname)).text)[1];
}

// One disposable standalone candidate: an original folder and a separate copy folder.
// The bytes depend on the name only; a different folder gives a byte-identical candidate.
export async function candidate(f, name, { image = PNG, folder = name } = {}) {
  const originalRoot = path.join(f.root, `cf-original-${folder}`), copyRoot = path.join(f.root, `cf-copy-${folder}`);
  const files = {
    "index.html": `<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><section data-double-id="candidate" data-container="Candidate ${name}"><h1>${name}</h1><img src="assets/image.png" alt="Preview"></section></body></html>`,
    "assets/site.css": `section { padding: 1rem; color: #${(name.length * 1118481 % 0xffffff).toString(16).padStart(6, "0")}; }`,
    "assets/image.png": image,
  };
  const originalFiles = [];
  for (const dir of [originalRoot, copyRoot]) await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  for (const [file, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(originalRoot, file), bytes);
    await fs.writeFile(path.join(copyRoot, file), bytes);
    originalFiles.push({ path: path.join(originalRoot, file), sha256: digest(bytes) });
  }
  return { label: `Candidate ${name}`, original: { entry: path.join(originalRoot, "index.html"), files: originalFiles },
    copy: { root: copyRoot, entry: "index.html", assets: ["assets/site.css", "assets/image.png"] } };
}

export async function coinflip(t, s, f, { origin = { piSessionId: "coinflip-origin", piSessionFile: f.root + "/pi.jsonl" } } = {}) {
  const post = (route, body) => s.api(route, { method: "POST", body });
  const connected = await post("/api/double/gui/connect", origin);
  if (connected.status !== 200) throw new Error(JSON.stringify(connected.json));
  const token = await browserToken(s.port, connected.json.path);
  const owner = (route, body) => request(s.port, route, { token, method: "POST", body });
  let sequence = 0;
  const api = {
    post, owner, connected: connected.json,
    async start(brief = "A compact pricing card") {
      const answer = await post("/api/double/gui/start", { actionId: `start-${sequence++}`, mode: "coinflip", brief });
      if (answer.status !== 200) throw new Error(JSON.stringify(answer.json));
      return answer.json.result.sessionId;
    },
    view: async (id) => (await s.api(croute(id))).json.view,
    events: async (id) => (await s.api(croute(id) + "/events")).json,
    async generation(id) { return (await api.events(id)).events.filter((e) => e.kind === "generation").at(-1); },
    // Attach an initial pair or a challenger built from the event payload, as the agent would.
    async attach(id, panes, { event, actionId = `attach-${sequence++}`, candidates } = {}) {
      event ??= await api.generation(id);
      const manifest = { comparisonId: `round-${sequence++}`, label: "Coinflip pair", panes };
      // An initial request and a pre-winner steer replace both sides; a challenger or a post-winner steer replaces one.
      candidates ??= !event.payload.replaceSide
        ? { left: { description: "Left direction" }, right: { description: "Right direction" } }
        : { [event.payload.replaceSide]: { description: `Challenger ${sequence}`, intendedDifference: "Switch from a stacked to a split layout" } };
      return post(croute(id) + "/attach", { actionId, requestId: event.payload.requestId, attemptId: event.payload.attemptId, manifest, candidates });
    },
    choose: (id, view, side, note = null, actionId = `choose-${sequence++}`) =>
      owner(croute(id) + "/choose", { actionId, pairIndex: view.pair.index, winner: view.pair[side].candidateId, note }),
    steer: (id, view, instruction, actionId = `steer-${sequence++}`) =>
      owner(croute(id) + "/steer", { actionId, pairIndex: view.pair.index, instruction }),
  };
  return api;
}
