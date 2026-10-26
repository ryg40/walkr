import { doubleGuiSessionId } from "./shared-gui.js";
import { createCoinflipMode } from "./coinflip-server.js";
import { createTrainerMode } from "./trainer-gui.js";

// The shared-GUI mode table. A mode registers here and nowhere else in the shared seam:
//   name, label                         display identity; `name` is the saved start mode
//   sessionId(actionId)                 deterministic session identity for a start action
//   createInitial(input), read(id)      idempotent initial record and its saved view
//   terminal(view)                      false while the session blocks another start
//   running(view)                       "<sessionId>/<attemptId>" while generation runs, else null
//   settled(view)                       true when the Pi chat needs no listener: nothing more can be delivered
//   view(id, context)                   GUI view with private frame URLs (optional)
//   route(raw, req, res, context)       its own authenticated API and frame routes (optional)
// Public static files and the GUI panel markup are listed below; the browser shell table is
// src/shared-gui-mode-shells.js.
// Double keeps its existing routes in double-server.js. Trainer is listed when the server supplies the Trainer
// handler's service (its dataset store and page grants); the dataset and its page stay in the Trainer handler.
export function createSharedGuiModes({ archiveDir, stateDir, doubleSessions, trainer }) {
  const double = {
    name: "double", label: "Double", sessionId: doubleGuiSessionId,
    createInitial: (input) => doubleSessions.createInitial(input),
    read: (id) => doubleSessions.read(id),
    terminal: (view) => ["ended", "stopped"].includes(view.status),
    running: (view) => view.status === "generating" ? `${view.sessionId}/${view.generation?.attempt.id}` : null,
    settled: (view) => view.status === "stopped",
  };
  return { double, coinflip: createCoinflipMode({ archiveDir, stateDir }), ...(trainer ? { trainer: createTrainerMode({ archiveDir, trainer }) } : {}) };
}

// Served from src/ without credentials, like the Double STATIC set.
export const SHARED_GUI_MODE_ASSETS = new Set(["/shared-gui-mode-shells.js", "/steer-limits.js", "/coinflip-shell.js", "/coinflip.css", "/trainer-gui-shell.js", "/trainer-gui.css"]);
// Inserted after the shared start controls; each panel starts hidden.
export const SHARED_GUI_MODE_PANELS = ["coinflip-panel.html", "trainer-panel.html"];
