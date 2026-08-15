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

## Subagent and Plugin Usage

Use Claude Code's built-in subagents and installed development plugins,
including Superpowers when available, to complete phases efficiently.

Before starting implementation:

1. Inspect the requested phase.
2. Identify tasks that can be safely delegated.
3. Create a clear implementation plan.
4. Delegate only independent and bounded tasks.
5. Keep the main Claude session responsible for architecture,
   integration, final verification, and the completion report.

Suitable tasks for subagents include:

- Exploring the existing codebase
- Reviewing architecture and package boundaries
- Preparing test cases
- Reviewing code against the specification
- Security review
- Cross-platform compatibility review
- Documentation review
- Investigating isolated bugs
- Inspecting generated package output

Subagents must receive:

- A precise objective
- Relevant file paths
- Allowed and prohibited actions
- Expected output
- Testing requirements
- A clear completion condition

### Parallel Work Rules

Subagents may work in parallel only when their tasks are independent.

Do not allow multiple subagents to modify the same file or closely
related shared modules simultaneously.

Until Hall of Wisdom's Git worktree isolation is implemented:

- Prefer read-only parallel subagents.
- Allow parallel file editing only when ownership of files is
  completely separate.
- The main agent must inspect every subagent result before applying it.
- The main agent must resolve integration decisions itself.
- Subagents must not commit, push, merge, delete branches, or modify
  files outside the project directory.

### Quality Rules

For implementation tasks, prefer this workflow when practical:

1. Planning or exploration
2. Implementation
3. Specification-compliance review
4. Code-quality review
5. Security review
6. Type checking
7. Linting
8. Unit and integration testing
9. Main-agent final verification

Subagents must not claim that tests passed unless they actually ran them.

The main agent must rerun the complete workspace verification after
integrating subagent work. Subagent test results alone are not sufficient.

### Plugin Fallback

If Superpowers or another requested plugin is unavailable:

- Do not stop the phase.
- Use Claude Code's built-in Explore, Plan, general-purpose, or custom
  subagents where appropriate.
- Continue with the same planning, review, and verification discipline.

### Resource Control

Do not create subagents merely to make the process appear parallel.

Use subagents only when delegation provides a clear benefit.

Avoid:

- Recursive subagents creating uncontrolled additional subagents
- Duplicate investigation of the same task
- More agents than the phase reasonably requires
- Consuming subscription usage on trivial operations
- Delegating final architectural responsibility

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
