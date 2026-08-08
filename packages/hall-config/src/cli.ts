#!/usr/bin/env node
import fs from "node:fs";
import { runCli } from "./run-cli.js";

const UTF8_BOM_CODE_POINT = 0xfeff;

function readStdinSync(): string {
  try {
    const raw = fs.readFileSync(0, "utf8");
    // Strip a leading UTF-8 BOM. Windows PowerShell 5.1 with a UTF-8
    // console (chcp 65001 - which Windows 11's "Use Unicode UTF-8 for
    // worldwide language support" option enables globally) prepends a BOM
    // to every text stream it pipes into a native command. JSON.parse
    // rejects a leading U+FEFF, so without this the installer's
    // `<json> | node dist/cli.js save` fails with "stdin was not valid
    // JSON" on an otherwise perfectly valid candidate. Compared by code
    // point rather than a literal so this source file stays pure ASCII.
    return raw.charCodeAt(0) === UTF8_BOM_CODE_POINT ? raw.slice(1) : raw;
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
