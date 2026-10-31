package ge.greentaxi.calls;

/**
 * Coalesces status requests against elapsed realtime, not the adjustable wall
 * clock. The service owns executors, connection lifetime and in-flight work.
 */
final class HeartbeatPolicy {
    static final long MIN_INTERVAL_MS = 15_000;
    private long lastObservedAt = -1;
    private long lastAttemptAt = -1;
    private long pendingAt = -1;

    /** Returns the earliest allowed pending deadline, or -1 when none is representable. */
    synchronized long request(long elapsedNow, long delayMillis) {
        if (delayMillis < 0) throw new IllegalArgumentException("Negative heartbeat delay");
        observe(elapsedNow);
        if (lastAttemptAt > Long.MAX_VALUE - MIN_INTERVAL_MS) {
            // No future elapsed timestamp can satisfy the rate limit. Avoid a
            // zero-delay rescheduling loop at a saturated clock value.
            pendingAt = -1;
            return -1;
        }
        long minimum = lastAttemptAt < 0 ? elapsedNow : lastAttemptAt + MIN_INTERVAL_MS;
        long desired = Math.max(addSaturated(elapsedNow, delayMillis), minimum);
        pendingAt = pendingAt < 0 ? desired : Math.min(pendingAt, desired);
        return pendingAt;
    }

    synchronized long nextAt() { return pendingAt; }

    /** Consumes a due request and starts the minimum interval for every attempt, including failures. */
    synchronized boolean begin(long elapsedNow) {
        observe(elapsedNow);
        if (pendingAt < 0 || elapsedNow < pendingAt) return false;
        if (lastAttemptAt >= 0 && elapsedNow - lastAttemptAt < MIN_INTERVAL_MS) return false;
        pendingAt = -1;
        lastAttemptAt = elapsedNow;
        return true;
    }

    /** Cancel pending work without forgetting the last attempt's rate limit. */
    synchronized void clear() { pendingAt = -1; }

    private void observe(long elapsedNow) {
        if (elapsedNow < 0) throw new IllegalArgumentException("Negative elapsed realtime");
        if (lastObservedAt >= 0 && elapsedNow < lastObservedAt) {
            // A service normally never sees elapsed realtime go backwards. If
            // its time source does, wait one interval rather than flood status.
            lastAttemptAt = elapsedNow;
            if (pendingAt >= 0) pendingAt = addSaturated(elapsedNow, MIN_INTERVAL_MS);
        }
        lastObservedAt = elapsedNow;
    }

    private static long addSaturated(long first, long second) {
        return first > Long.MAX_VALUE - second ? Long.MAX_VALUE : first + second;
    }
}
