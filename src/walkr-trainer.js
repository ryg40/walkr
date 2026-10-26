#!/usr/bin/env node
import fs from "node:fs";
import { runTrainer } from "./trainer-cli.js";

const args = process.argv.slice(2);
try {
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    console.log(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } else {
    await runTrainer(args);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
