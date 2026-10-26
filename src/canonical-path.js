import path from "node:path";

// Windows device names stay devices in any directory and with any extension.
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * True for one exact spelling of an absolute directory or file: no traversal,
 * no trailing separator, no control characters and no foreign separator.
 * POSIX refuses the backslash. Windows needs an uppercase drive letter and
 * refuses UNC and device roots, alternate data streams, wildcards, device
 * names and the trailing dots or spaces that Windows silently strips.
 * Short 8.3 names (RUNNER~1) are not detectable without the filesystem.
 */
export function isCanonicalAbsolute(value, p = path) {
  if (typeof value !== "string" || !p.isAbsolute(value) || value === p.parse(value).root ||
      value.endsWith(p.sep) || p.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (p.sep === "/") return !value.includes("\\");
  if (!/^[A-Z]:\\/.test(value)) return false;
  return value.slice(3).split("\\").every((part) => !/[<>:"/|?*]|[. ]$/.test(part) && !DEVICE.test(part));
}

/** True when one path is the other or contains it; Windows compares without case. */
export function overlaps(a, b, p = path) {
  const fold = (value) => (p.sep === "\\" ? value.toLowerCase() : value);
  const [x, y] = [fold(a), fold(b)];
  return x === y || x.startsWith(`${y}${p.sep}`) || y.startsWith(`${x}${p.sep}`);
}
