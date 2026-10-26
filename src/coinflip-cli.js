import fs from "node:fs/promises";
import path from "node:path";
import { encodeDoubleComparisonId } from "./double-route.js";
import { configuration, connectDoubleClient, request } from "./double-client.js";
import { contains } from "./double-archive.js";
import { posixOnlyRefusal } from "./posix-only.js";

const HELP = `walkr-coinflip
  gui view                                   Read bound chat, connection, and saved GUI sessions
  session <view|events|output> <session-id>  Read state, receive events, or read the submitted final packet
  session <attach|fail|ack> <session-id> <absolute-request.json>
                                             Submit the exact saved agent request; never generate IDs on retry
  session export-winner <session-id> <absolute-new-folder>
                                             Write the archived winner as a new original and copy folder pair and
                                             print its manifest pane; use it when the winner's copy folder is gone

Coinflip runs only in the local shared GUI. Choose, Stop, Submit, Retry and recovery are GUI actions.
Requires explicit absolute HUMAN_REVIEW_STATE_DIR and HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR and an existing
server started with walkr-double serve. This command never starts, replaces, or restarts a service,
opens a browser, launches a chat, loads an extension, or requests inference.
For the shared GUI, separately approve and load integrations/pi/shared-gui.ts in the originating
persistent Pi chat, then explicitly run /shared-gui {"action":"connect"} and use its private URL.
Reconnect explicitly in that same chat; there is no automatic reconnect. Hosted Coinflip is not available.
Modes: walkr-core, walkr-double, walkr-coinflip, walkr-trainer. walkr-trainer --help explains local Trainer.
`;
const fail = (message) => { throw new Error(message); };
const stdout = (text) => new Promise((resolve) => process.stdout.write(text, resolve));

function parse(args) {
  const [command, ...rest] = args;
  if (command === "gui" && rest.length === 1 && rest[0] === "view") return { command };
  if (command === "session") {
    const [operation, ...parts] = rest;
    if (["view", "events", "output"].includes(operation) && parts.length === 1) return { command, operation, segment: encodeDoubleComparisonId(parts[0]) };
    if (["attach", "fail", "ack"].includes(operation) && parts.length === 2 && path.isAbsolute(parts[1])) {
      return { command, operation, segment: encodeDoubleComparisonId(parts[0]), input: parts[1] };
    }
    if (operation === "export-winner" && parts.length === 2 && path.isAbsolute(parts[1])) {
      return { command, operation, segment: encodeDoubleComparisonId(parts[0]), folder: path.resolve(parts[1]) };
    }
  }
  fail("Invalid Coinflip arguments. Use walkr-coinflip --help.");
}

// A new folder outside the archive and state: an existing folder must be empty.
async function emptyFolder(folder, { archiveDir, stateDir }) {
  if ([archiveDir, stateDir].some((root) => contains(root, folder) || contains(folder, root))) fail("Name an export folder outside the archive and state directories.");
  let entries = [];
  try { entries = await fs.readdir(folder); } catch (error) { if (error.code !== "ENOENT") fail("Cannot read the export folder. Name a new absolute folder."); }
  if (entries.length) fail("The export folder exists and is not empty. Name a new folder.");
}

// The archived bytes become a separate original and copy; the server still checks them against the archive on attach.
async function writeWinner(folder, winner) {
  const originalRoot = path.join(folder, "original"), copyRoot = path.join(folder, "copy"), originals = [];
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const root of [originalRoot, copyRoot]) await fs.mkdir(root, { mode: 0o700 });
  for (const file of winner.files) {
    const bytes = Buffer.from(file.base64, "base64");
    for (const root of [originalRoot, copyRoot]) {
      const full = path.resolve(root, file.path);
      if (!full.startsWith(`${root}${path.sep}`)) fail("The archived winner has an unsafe file path.");
      await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await fs.writeFile(full, bytes, { flag: "wx", mode: 0o600 });
    }
    originals.push({ path: path.join(originalRoot, file.path), sha256: file.sha256 });
  }
  return { label: winner.label, original: { entry: path.join(originalRoot, winner.entry), files: originals },
    copy: { root: copyRoot, entry: winner.entry, assets: winner.files.map((f) => f.path).filter((file) => file !== winner.entry) } };
}

export async function runCoinflip(args) {
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) return stdout(HELP);
  const refusal = posixOnlyRefusal(); // Before hosted, argument and path checks; help stays available.
  if (refusal) fail(refusal);
  let config; // Hosted rejection precedes argument and path access. Coinflip shares the Double configuration.
  try { config = configuration(); } catch (error) { fail(error.message.replace(/^Double/, "Coinflip")); }
  const options = parse(args);
  let body;
  if (options.input) {
    try { body = JSON.parse(await fs.readFile(options.input, "utf8")); }
    catch { fail("Cannot read the JSON Coinflip request. Supply an absolute readable file path."); }
  }
  if (options.folder) await emptyFolder(options.folder, config);
  const { server } = await connectDoubleClient(config, { sessions: true });
  if (options.folder) {
    const winner = await request(server, `/api/double/modes/coinflip/sessions/${options.segment}/winner`);
    return stdout(`${JSON.stringify({ candidateId: winner.candidateId, side: winner.side, pane: await writeWinner(options.folder, winner) })}\n`);
  }
  const route = options.command === "gui" ? "/api/double/gui"
    : `/api/double/modes/coinflip/sessions/${options.segment}${options.operation === "view" ? "" : `/${options.operation}`}`;
  return stdout(`${JSON.stringify(await request(server, route, body === undefined ? {} : { method: "POST", body }))}\n`);
}
