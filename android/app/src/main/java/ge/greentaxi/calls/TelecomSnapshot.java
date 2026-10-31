package ge.greentaxi.calls;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Immutable evidence from one Telecom Call; never infers an answer from SIM-wide state. */
final class TelecomSnapshot {
    enum State { RINGING, ACTIVE, HOLDING, ENDED, UNANSWERED, OTHER }
    final String sessionKey;
    final int subId;
    final String phone;
    final long createdAt, connectedAt, observedAt, observedElapsed;
    final State state;

    TelecomSnapshot(String callId, String accountId, int subId, String phone,
                    long createdAt, long connectedAt, long observedAt, long observedElapsed, State state) {
        if (callId == null || callId.isEmpty() || accountId == null || accountId.isEmpty()
                || createdAt <= 0 || subId < 0 || state == null) {
            throw new IllegalArgumentException("unverified_telecom_identity");
        }
        this.sessionKey = identity(callId, accountId, createdAt);
        this.subId = subId;
        this.phone = phone;
        this.createdAt = createdAt;
        this.connectedAt = connectedAt;
        this.observedAt = observedAt;
        this.observedElapsed = observedElapsed;
        this.state = state;
    }

    boolean accepted() {
        // A rebound service can first see an already held or just disconnected call.
        // A positive Telecom connect timestamp is then required; RINGING never qualifies.
        return state == State.ACTIVE || connectedAt > 0 && (state == State.HOLDING || state == State.ENDED);
    }

    long answerAt() { return connectedAt > 0 ? connectedAt : observedAt; }
    long elapsedAt(long wallAt) {
        long age = wallAt < observedAt ? observedAt - wallAt : 0;
        if (age < 0 || age > observedElapsed) return 0;
        return observedElapsed - age;
    }

    static boolean isTelecomSession(String value) {
        return value != null && value.matches("^telecom:[0-9a-f]{64}$");
    }

    private static String identity(String callId, String accountId, long creation) {
        // Telecom IDs may be reused after reboot. Account and creation time are essential.
        // Length framing prevents ambiguous concatenations; raw account/Telecom IDs never leave SQLite.
        String framed = callId.length() + ":" + callId + accountId.length() + ":" + accountId + ":" + creation;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(framed.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder("telecom:");
            for (byte value : digest) result.append(Character.forDigit((value >>> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("sha256_unavailable");
        }
    }
}
