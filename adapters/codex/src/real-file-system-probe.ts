import { statSync } from "node:fs";
import type { FileSystemProbe } from "./executable-resolver.js";

/** The only place in this package that touches the real filesystem for executable resolution. */
export const realFileSystemProbe: FileSystemProbe = {
  isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};
