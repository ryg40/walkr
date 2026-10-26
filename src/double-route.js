/**
 * Comparison-ID path segment codec, shared by the browser shell, the server,
 * and the CLI. Pure, with no imports, so the browser loads it as
 * `/double-route.js`.
 *
 *   segment = "~" + encodeURIComponent(comparisonId)
 *
 * The literal prefix keeps every segment from being a dot segment, so URL
 * parsing never turns the IDs "." and ".." into path navigation. The segment
 * is public identity, not authority.
 */

const PREFIX = "~";
// The input validator's identity contract: nonempty, no whitespace, no Unicode category C.
const ID_FORBIDDEN = /[\s\p{C}]/u;

const validId = (value) => typeof value === "string" && value.length > 0 && !ID_FORBIDDEN.test(value);

function routeError(code, message) {
  const error = new Error(message);
  error.name = "DoubleRouteError";
  error.code = code;
  return error;
}

/** Encode an exact valid comparison ID as one path segment. Throws INVALID_ID. */
export function encodeDoubleComparisonId(id) {
  if (!validId(id)) {
    throw routeError("INVALID_ID", "A comparison ID must be nonempty and contain no whitespace or control characters.");
  }
  return PREFIX + encodeURIComponent(id);
}

/**
 * Decode one raw path segment back to its comparison ID. Removes exactly one
 * prefix, decodes exactly once, and accepts only the canonical encoding of a
 * valid ID. Throws INVALID_SEGMENT for anything else.
 */
export function decodeDoubleComparisonId(segment) {
  const invalid = () => routeError("INVALID_SEGMENT", "The path segment is not a canonical comparison ID.");
  if (typeof segment !== "string" || !segment.startsWith(PREFIX)) throw invalid();
  let id;
  try {
    id = decodeURIComponent(segment.slice(PREFIX.length));
  } catch {
    throw invalid();
  }
  if (!validId(id) || PREFIX + encodeURIComponent(id) !== segment) throw invalid();
  return id;
}
