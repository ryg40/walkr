import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCoreWakeChat, INTERVAL, LIFETIME } from "../../src/core-wake-chat.js";

// Explicit -e only. Loading registers interfaces; only an explicit connect binds this chat and starts the watcher.
export default function coreWake(pi: ExtensionAPI) {
  installCoreWakeChat(pi, Type.Object({
    action: Type.Union(["connect", "status", "disconnect"].map((value) => Type.Literal(value))),
    target: Type.Optional(Type.String({ description: "Exact review target of the walkr-core commands, for connect." })),
    intervalSeconds: Type.Optional(Type.Number({ minimum: INTERVAL.min, maximum: INTERVAL.max })),
    timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: LIFETIME.max })),
  }));
}
