import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import type { ComparisonInternalPathsPort } from "./comparison-internal-paths-port.js";

export interface SqliteComparisonInternalPathsOptions {
  readonly db: HallDatabase;
}

/**
 * SQLite-backed sibling of `ComparisonOrchestrator`'s private path maps —
 * see `comparison-internal-paths-port.ts`'s doc comment for why this is
 * kept structurally separate from `SqliteComparisonStore`. Absolute paths
 * held here are never re-validated through a domain Zod schema (there is
 * none for a raw filesystem path) and are never read by anything outside
 * the persistence layer and `restart-recovery.ts` — never a route.
 */
export class SqliteComparisonInternalPaths implements ComparisonInternalPathsPort {
  readonly #db: HallDatabase;

  constructor(options: SqliteComparisonInternalPathsOptions) {
    this.#db = options.db;
  }

  setSourceRepositoryPath(comparisonId: string, sourceRepositoryPath: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO comparison_internal_paths (comparison_id, source_repository_path) VALUES (?, ?)
           ON CONFLICT(comparison_id) DO UPDATE SET source_repository_path = excluded.source_repository_path`,
        )
        .run(comparisonId, sourceRepositoryPath);
    });
  }

  deleteSourceRepositoryPath(comparisonId: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare("DELETE FROM comparison_internal_paths WHERE comparison_id = ?")
        .run(comparisonId);
    });
  }

  setWorktreePath(candidateId: string, comparisonId: string, worktreePath: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO comparison_candidate_worktrees (candidate_id, comparison_id, worktree_path)
           VALUES (?, ?, ?)
           ON CONFLICT(candidate_id) DO UPDATE SET worktree_path = excluded.worktree_path`,
        )
        .run(candidateId, comparisonId, worktreePath);
    });
  }

  deleteWorktreePath(candidateId: string): void {
    withTransaction(this.#db, () => {
      this.#db
        .prepare("DELETE FROM comparison_candidate_worktrees WHERE candidate_id = ?")
        .run(candidateId);
    });
  }

  listAll(): {
    readonly sourceRepositoryPaths: readonly {
      readonly comparisonId: string;
      readonly sourceRepositoryPath: string;
    }[];
    readonly worktreePaths: readonly {
      readonly candidateId: string;
      readonly comparisonId: string;
      readonly worktreePath: string;
    }[];
  } {
    const repoRows = this.#db
      .prepare("SELECT comparison_id, source_repository_path FROM comparison_internal_paths")
      .all() as unknown as { comparison_id: string; source_repository_path: string }[];
    const worktreeRows = this.#db
      .prepare(
        "SELECT candidate_id, comparison_id, worktree_path FROM comparison_candidate_worktrees",
      )
      .all() as unknown as { candidate_id: string; comparison_id: string; worktree_path: string }[];

    return {
      sourceRepositoryPaths: repoRows.map((row) => ({
        comparisonId: row.comparison_id,
        sourceRepositoryPath: row.source_repository_path,
      })),
      worktreePaths: worktreeRows.map((row) => ({
        candidateId: row.candidate_id,
        comparisonId: row.comparison_id,
        worktreePath: row.worktree_path,
      })),
    };
  }
}
