"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { ApiClientError, getAuthSession, login, logout } from "../lib/api-client";
import { resolveHallCoreUrl } from "../lib/hall-core-url";

interface HallAuthContextValue {
  readonly logout: () => Promise<void>;
  readonly loggingOut: boolean;
}

const HallAuthContext = createContext<HallAuthContextValue | null>(null);

export function useHallAuth(): HallAuthContextValue {
  const context = useContext(HallAuthContext);
  if (context === null) throw new Error("useHallAuth must be used within HallAuthGate.");
  return context;
}

function LoginScreen({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const { httpUrl: baseUrl } = resolveHallCoreUrl();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(baseUrl, username, password);
      onSignedIn();
    } catch (caught) {
      setError(
        caught instanceof ApiClientError && caught.code === "AUTH_INVALID_CREDENTIALS"
          ? "Invalid username or password"
          : "Could not sign in. Make sure Hall Core is running.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        className="flex w-full max-w-sm flex-col gap-5 rounded-xl border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-900"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Hall of Wisdom</h1>
          <p className="text-sm text-stone-600 dark:text-stone-300">Sign in to continue.</p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Username
          <input
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
            autoComplete="username"
            required
            className="rounded border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            autoComplete="current-password"
            required
            className="rounded border border-stone-300 bg-white px-3 py-2 text-stone-900 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-amber-700 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export function HallAuthGate({ children }: { readonly children: ReactNode }) {
  const { httpUrl: baseUrl } = resolveHallCoreUrl();
  const [state, setState] = useState<"checking" | "signed_in" | "signed_out">("checking");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    getAuthSession(baseUrl)
      .then((session) => {
        if (active) setState(session.authenticated ? "signed_in" : "signed_out");
      })
      .catch(() => {
        if (active) setState("signed_out");
      });
    return () => {
      active = false;
    };
  }, [baseUrl]);

  async function signOut(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout(baseUrl);
    } finally {
      setLoggingOut(false);
      setState("signed_out");
    }
  }

  if (state === "checking") {
    return (
      <main className="flex min-h-dvh items-center justify-center text-sm text-stone-500">
        Loading…
      </main>
    );
  }
  if (state === "signed_out") {
    return (
      <LoginScreen
        onSignedIn={() => {
          setState("signed_in");
        }}
      />
    );
  }

  return (
    <HallAuthContext.Provider value={{ logout: signOut, loggingOut }}>
      {children}
    </HallAuthContext.Provider>
  );
}
