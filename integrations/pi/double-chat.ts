import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDoubleChat } from "../../src/double-chat-subscription.js";

// Explicit -e only. Loading registers capabilities but does not start a listener.
export default function doubleChat(pi: ExtensionAPI) {
  installDoubleChat(pi, Type.Object({
    action: Type.Union(["start", "status", "cancel", "retry-ack"].map((value) => Type.Literal(value))),
    comparisonId: Type.String({ description: "Exact comparison identity bound to this originating Pi session." }),
    timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3600 })),
  }));
}
