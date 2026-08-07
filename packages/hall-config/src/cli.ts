#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./run-cli.js";

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const command = process.argv[2];
const needsStdin = command === "validate" || command === "save";

const exitCode = runCli(process.argv.slice(2), {
  stdin: needsStdin ? readStdinSync() : "",
  writeStdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
});
process.exitCode = exitCode;
