import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installSharedGuiChat } from "../../src/shared-gui-chat.js";

// Loading registers interfaces only. Connection always requires an explicit command.
export default function sharedGui(pi: ExtensionAPI) {
  installSharedGuiChat(pi, Type.Object({
    action: Type.Union(["connect", "disconnect", "status", "retry-ack", "start", "cancel"].map((value) => Type.Literal(value))),
    sessionId: Type.Optional(Type.String({ description: "Shared-GUI session identity (Double, Coinflip, or Trainer) for retry-ack." })),
    doubleSessionId: Type.Optional(Type.String()),
    eventId: Type.Optional(Type.String()),
    timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3600 })),
  }));
}
