// Prompt-box instruction limits, shared by the stores and the browser shell.
// Every generation and final packet embeds all saved instructions, so their total stays well inside
// the 256 KiB receipt line budget.
export const STEER_TEXT_LIMIT = 8000;
export const STEER_TOTAL_BYTES = 16384;
const bytes = (text) => new TextEncoder().encode(text).length;
/**
 * Null when a new instruction fits beside the saved ones, else the refusal message.
 * Check only new requests: saved receipts replay without these limits, so a later limit change never breaks a record.
 */
export function steerProblem(saved, instruction, { text = STEER_TEXT_LIMIT, total = STEER_TOTAL_BYTES } = {}) {
  if (typeof instruction !== "string" || !instruction.trim() || instruction.length > text) {
    return `Supply a nonblank instruction of at most ${text} characters.`;
  }
  if (bytes(instruction) > total) {
    return `This instruction alone is ${bytes(instruction)} bytes of UTF-8, more than the ${total / 1024} KiB that one session holds for all instructions. Shorten it.`;
  }
  if (saved.reduce((sum, item) => sum + bytes(item), bytes(instruction)) > total) {
    return `The saved instructions of this session would pass ${total / 1024} KiB in total. End or stop this session and start a new one.`;
  }
  return null;
}
