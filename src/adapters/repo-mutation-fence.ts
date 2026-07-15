import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export type RepoMutationFenceResult =
  { ok: true; release: () => void } | { ok: false; error: string };

/**
 * Hold a crash-safe, cross-process write fence scoped to one Git repository.
 * A dedicated SQLite file in the common Git directory avoids blocking writes
 * to Momentum's global state database or to unrelated repositories.
 */
export function acquireRepoMutationFence(
  repoPath: string,
): RepoMutationFenceResult {
  let db: DatabaseSync | undefined;
  try {
    const commonDirRaw = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    const commonDir = path.isAbsolute(commonDirRaw)
      ? commonDirRaw
      : path.resolve(repoPath, commonDirRaw);
    db = new DatabaseSync(
      path.join(commonDir, "momentum-mutation-fence.sqlite"),
    );
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        try {
          db?.exec("COMMIT");
        } finally {
          db?.close();
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {}
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
