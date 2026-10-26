import { createHash } from "node:crypto";
import { configuration, connectDoubleClient, request } from "./double-client.js";
import { encodeDoubleComparisonId } from "./double-route.js";

// The CLI's private HTTP boundary, without a new child for every event read.
export function createDoubleSessionChatClient(env = process.env) {
  const config = configuration({ ...env });
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  let server;
  function call(id, suffix, signal, body) {
    if (!server) throw new Error("Double session client is not connected.");
    return request(server, `/api/double/sessions/${encodeDoubleComparisonId(id)}${suffix}`, {
      signal, ...(body === undefined ? {} : { method: "POST", body }),
    });
  }
  return {
    archiveId: hash(config.archiveDir), stateId: hash(config.stateDir),
    async connect(signal) { ({ server } = await connectDoubleClient(config, { signal, sessions: true })); },
    view: (id, signal) => call(id, "", signal),
    events: (id, signal) => call(id, "/events", signal),
    output: (id, signal) => call(id, "/output", signal),
    acknowledge: (id, body, signal) => call(id, "/ack", signal, body),
  };
}
