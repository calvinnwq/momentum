/**
 * Daemon and lease staleness defaults.
 *
 * Default-resolution config support, not domain behavior: the daemon status
 * inspector (`core/daemon/status`), the CLI, and the daemon renderer all read
 * these to decide what to flag as stale. They surface stale records only and
 * never transition state.
 */

/**
 * Default cutoff between "active" and "stale" for daemon heartbeat surfaces.
 * Daemon recovery surfaces stale records without guessing recovery, so this only controls
 * what the read-only inspector flags; it does not transition state.
 */
export const DEFAULT_DAEMON_STALE_AFTER_MS = 90_000;
export const DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS = 930_000;

/**
 * Grace window applied when listing stale repo locks / queue claims. The lease
 * deadline is the contract, so once `lease_expires_at` has passed the holder
 * has lost authority; the grace tolerates small clock skew between the worker
 * that wrote the lease and the inspector reading it back. Surfaces only — no
 * recovery action is taken when a row crosses this threshold.
 */
export const DEFAULT_STALE_LEASE_GRACE_MS = 5_000;
