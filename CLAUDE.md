# CLAUDE.md

This file gives Claude Code project-specific context. The full set of working rules for any
coding agent in this repository — including hard rules, cross-platform requirements, code
quality, dependency policy, testing requirements, and the required end-of-phase report format —
lives in [`AGENTS.md`](AGENTS.md) and applies equally to Claude Code. Read it before making
changes.

## Claude Code specific notes

- This project is being driven by a phase-by-phase build plan defined by the user (see
  `docs/architecture/0001-initial-architecture.md`). Do not skip ahead to a later phase without
  explicit approval, even if it looks like the natural next step.
- The user works primarily in Windows PowerShell 5.1. Prefer PowerShell-compatible commands and
  note where Bash differs.
- Node.js on this machine is `>=24.11.0 <25` (current LTS) and pnpm is pinned to `10.33.0` via the
  root `package.json` `packageManager` field — do not suggest downgrading either.
