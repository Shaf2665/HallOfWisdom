import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const HALL_SESSION_COOKIE_NAME = "hall_session";
export const HALL_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const ROOT_ENV_PATH = fileURLToPath(new URL("../../../../.env", import.meta.url));

interface SessionPayload {
  readonly username: string;
  readonly expiresAt: number;
}

export interface HallAuthCredentials {
  readonly username: string;
  readonly password: string;
  readonly sessionSecret: string;
}

export interface HallAuthentication {
  readonly enabled: true;
  authenticate(username: string, password: string, now?: Date): string | undefined;
  hasSession(cookieHeader: string | undefined, now?: Date): boolean;
  clearSession(): string;
}

function nonBlank(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === "" ? fallback : value;
}

function sessionSignature(payload: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function safelyEquals(left: string, right: string, sessionSecret: string): boolean {
  const leftDigest = createHmac("sha256", sessionSecret).update(left).digest();
  const rightDigest = createHmac("sha256", sessionSecret).update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function serializeSession(value: string, expiresAt: Date): string {
  return [
    `${HALL_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${String(HALL_SESSION_MAX_AGE_SECONDS)}`,
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

/** Loads only the root runtime environment file; values already supplied by the process remain supported by Node's native loader. */
export function loadHallRootEnvironment(): void {
  if (fs.existsSync(ROOT_ENV_PATH)) process.loadEnvFile(ROOT_ENV_PATH);
}

export function resolveHallAuthCredentials(): HallAuthCredentials {
  return {
    username: nonBlank(process.env.HALL_LOGIN_USERNAME, "admin"),
    password: nonBlank(process.env.HALL_LOGIN_PASSWORD, "hallofwisdom"),
    sessionSecret: nonBlank(process.env.HALL_SESSION_SECRET, randomBytes(32).toString("base64url")),
  };
}

export function createHallAuthentication(credentials: HallAuthCredentials): HallAuthentication {
  function hasSession(cookieHeader: string | undefined, now: Date = new Date()): boolean {
    const value = readCookie(cookieHeader, HALL_SESSION_COOKIE_NAME);
    if (value === undefined) return false;
    const [payload, signature, extra] = value.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) return false;
    if (
      !safelyEquals(
        signature,
        sessionSignature(payload, credentials.sessionSecret),
        credentials.sessionSecret,
      )
    ) {
      return false;
    }
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        typeof (decoded as SessionPayload).username !== "string" ||
        typeof (decoded as SessionPayload).expiresAt !== "number"
      ) {
        return false;
      }
      const session = decoded as SessionPayload;
      return (
        session.expiresAt > now.getTime() &&
        safelyEquals(session.username, credentials.username, credentials.sessionSecret)
      );
    } catch {
      return false;
    }
  }

  return {
    enabled: true,
    authenticate(username: string, password: string, now: Date = new Date()): string | undefined {
      if (
        !safelyEquals(username, credentials.username, credentials.sessionSecret) ||
        !safelyEquals(password, credentials.password, credentials.sessionSecret)
      ) {
        return undefined;
      }
      const expiresAt = new Date(now.getTime() + HALL_SESSION_MAX_AGE_SECONDS * 1000);
      const payload = Buffer.from(
        JSON.stringify({ username: credentials.username, expiresAt: expiresAt.getTime() }),
        "utf8",
      ).toString("base64url");
      return serializeSession(
        `${payload}.${sessionSignature(payload, credentials.sessionSecret)}`,
        expiresAt,
      );
    },
    hasSession,
    clearSession(): string {
      return `${HALL_SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=${new Date(0).toUTCString()}`;
    },
  };
}
