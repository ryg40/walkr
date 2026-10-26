import fs from "node:fs";
import path from "node:path";

export function assertHostedTarget(target) {
  if (process.env.HUMAN_REVIEW_HOSTED !== "1") return;
  if (target.kind !== "file") {
    throw new Error("Hosted reviews accept mounted HTML and Markdown files, not localhost URLs.");
  }
  const file = fs.realpathSync(target.value);
  const roots = JSON.parse(process.env.HUMAN_REVIEW_ROOTS || "[]");
  const allowed = roots.some((root) => {
    const relative = path.relative(fs.realpathSync(root), file);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!allowed || !/\.(html?|xhtml|md|markdown)$/i.test(file) || !fs.statSync(file).isFile()) {
    throw new Error("Review target must be an HTML or Markdown file inside an approved project mount.");
  }
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
