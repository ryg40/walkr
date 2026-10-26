import { mountCoinflip, coinflipRoute } from "./coinflip-shell.js";
import { mountTrainerGui, trainerGuiRoute } from "./trainer-gui-shell.js";

// Browser half of the shared-GUI mode table (server half: src/shared-gui-modes.js).
// Each mode mounts its own panel and names its authenticated view route. Double stays built in.
export const MODE_SHELLS = {
  coinflip: { label: "Coinflip", mount: mountCoinflip, route: coinflipRoute },
  trainer: { label: "Training", mount: mountTrainerGui, route: trainerGuiRoute },
};
