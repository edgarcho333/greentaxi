package ge.greentaxi.calls;

/** Small, deterministic delivery rules shared by the durable queue and JVM tests. */
final class DeliveryPolicy {
    private static final long[] RETRY_DELAYS_MS = {3_000L, 10_000L, 30_000L, 60_000L, 120_000L};
    static final int MAX_URGENT_STREAK = 4;

    private DeliveryPolicy() {}

    static long retryDelayMillis(int attempt) {
        return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1];
    }

    static boolean preferUrgent(int urgentStreak) {
        return urgentStreak < MAX_URGENT_STREAK;
    }

    static int afterSelection(int urgentStreak, boolean urgentSelected) {
        return urgentSelected ? Math.min(MAX_URGENT_STREAK - 1, Math.max(0, urgentStreak)) + 1 : 0;
    }

    static String safeErrorCode(String value) {
        if (value == null || value.isEmpty()) return "";
        if (value.matches("http_[1-5][0-9]{2}")) return value;
        if (value.equals("connection_failed") || value.equals("response_invalid") || value.equals("network_unavailable")) return value;
        // Never expose arbitrary exception text or an old persisted secret in diagnostics.
        return "connection_failed";
    }
}
