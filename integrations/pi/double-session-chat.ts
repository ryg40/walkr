import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDoubleSessionChat } from "../../src/double-session-chat.js";

// Opt-in only. Loading does not connect, listen, or start a model turn.
export default function doubleSessionChat(pi: ExtensionAPI) {
  installDoubleSessionChat(pi, Type.Object({
    action: Type.Union(["start", "status", "cancel", "retry-ack"].map((value) => Type.Literal(value))),
    doubleSessionId: Type.String({ description: "Double session identity, not the originating Pi session ID." }),
    eventId: Type.Optional(Type.String({ description: "Exact event identity for retry-ack; no redelivery." })),
    timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3600 })),
  }));
}
