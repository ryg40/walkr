import fs from "node:fs";
import os from "node:os";

// On macOS os.tmpdir() sits under /var, a symlink to /private/var. Walkr refuses
// symlinked parents on purpose, so tests build their paths from the real path.
// The native call also gives the long Windows name for a short 8.3 name (RUNNER~1).
export const tmpRoot = fs.realpathSync.native(os.tmpdir());
