# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, OpenCode, or otherwise) working in this
repository.

## What this project is

Hall of Wisdom is a cross-platform Agent OS and coding-agent orchestrator. A "CEO Agent" will
eventually break down user requests, assign them to coding agents (Claude Code, Codex, OpenCode,
Antigravity, and others), monitor their work, request reviews, and ask for human approval before
anything is merged or deployed. See `docs/architecture/0001-initial-architecture.md` for the full
design and the phase-by-phase build plan.

## How to work in this repository

- **Work in small, testable phases.** Do not build multiple milestones in one change. Stop after
  each phase and wait for review before continuing.
- **Explain before editing.** State the objective, the files you intend to touch, why each file is
  needed, and the commands you will run, before making changes.
- **Inspect before changing.** Read existing files before modifying them. Do not overwrite working
  code. Reuse existing utilities instead of duplicating them.
- **Do not create empty placeholder packages or directories** for functionality that isn't needed
  yet. Create a package only when a phase actually requires it.

## Hard rules

- **No destructive commands** without explicit user approval: no `git reset --hard`,
  `git clean -fd`, `rm -rf`, force pushes, branch deletion, database deletion, or deleting user
  files.
- **Never commit unless explicitly asked to.**
- **Never read, log, or transmit credentials** for Claude, Codex, GitHub, Azure DevOps, or any
  other agent/provider. Each coding agent runs through the user's own local, already-authenticated
  installation; Hall of Wisdom does not collect or upload subscription credentials.
- **Do not modify files outside the project directory.**
- **Validate all paths** and prevent path traversal. Prefer structured process arguments over
  building shell command strings; avoid shell interpolation.

## Cross-platform requirements

This project targets Windows 10/11 (including WSL2), Linux, and macOS.

- Do not assume `/bin/bash`, Unix-only paths, Unix signals, `chmod`, symlinks, or a case-sensitive
  filesystem.
- Use Node.js's cross-platform APIs (`path`, `os`, etc.) instead of hand-rolled path logic.
- Test against Windows-style paths (e.g. `C:\Projects\hall-of-wisdom`) and paths containing
  spaces.
- When giving shell commands, provide both PowerShell and Bash versions if they differ.

## Code quality

- Strict TypeScript. No `any`.
- Small modules, clear names, typed errors, centralized logging, no hidden global state, no
  hard-coded absolute paths, no silent error handling, no unbounded process execution.
- Minimal comments — only where the _why_ isn't obvious from the code itself.

## Dependencies

Before adding a dependency: explain why it's needed, prefer actively maintained packages, avoid
duplicate libraries that serve the same purpose, and check whether the functionality can be
implemented safely without adding a package.

## Testing requirements (every phase)

Run and report: type checking, linting, formatting check, unit tests, and any relevant integration
tests. Manually validate the main user flow. Check Windows path compatibility and paths containing
spaces. Before declaring a phase complete, review for command injection, path traversal, secret
leakage, unsafe file deletion, unhandled promise rejections, race conditions, process leaks, and
invalid state transitions. Fix what's found before reporting the phase as done.

## Required end-of-phase report

Every phase ends with: Phase Completed, What Was Implemented, Files Created or Changed, Commands
Executed, Test Results, Security and Bug Review, How to Verify, Expected Output, Git Status, Next
Proposed Phase, and a `STOPPED` line. Do not continue to the next phase automatically.
