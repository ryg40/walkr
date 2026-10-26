// Double, Coinflip, the shared GUI and Trainer rely on POSIX owner and mode checks, directory
// fsync and O_NOFOLLOW. Windows has none of them, so these modes refuse there at their entry
// points instead of running with weaker checks. Core review and setup stay supported.
export const POSIX_ONLY_CODE = "PLATFORM_UNSUPPORTED";
export const POSIX_ONLY_MESSAGE = "Double, Coinflip, the shared GUI and Trainer need Linux or macOS. " +
  "On Windows, Walkr supports Core review and walkr-core setup only.";

/** The refusal message on Windows, else null. `platform` is injectable for tests. */
export function posixOnlyRefusal(platform = process.platform) {
  return platform === "win32" ? POSIX_ONLY_MESSAGE : null;
}

/** Throws the refusal with code `POSIX_ONLY_CODE` on Windows. For client and store entry points. */
export function assertPosixOnly(platform = process.platform) {
  const refusal = posixOnlyRefusal(platform);
  if (refusal) throw Object.assign(new Error(refusal), { code: POSIX_ONLY_CODE });
}
