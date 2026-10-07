package ge.greentaxi.calls;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Conservatively associates finalized call-log rows with already answered live sessions. */
public final class CallReconciler {
    private static final long START_EARLY_MS = 10_000;
    private static final long START_LATE_MS = 2_000;
    private static final long DURATION_TOLERANCE_MS = 3_000;
    // Nearby inconsistent evidence remains unresolved instead of producing a second call card.
    private static final long POSSIBLE_EARLY_MS = 30_000;
    private static final long POSSIBLE_LATE_MS = 10_000;

    private CallReconciler() {}

    public static final class Session {
        public final String id;
        public final String eventId;
        public final int subId;
        public final String phoneGE9;
        public final long ringWall;
        public final long ringElapsed;
        public final long answerWall;
        public final long answerElapsed;
        /** Both end timestamps are -1 while no reliable end has been observed. */
        public final long endWall;
        public final long endElapsed;
        public final boolean gap;

        public Session(String id, String eventId, int subId, String phoneGE9,
                       long ringWall, long ringElapsed, long answerWall, long answerElapsed,
                       long endWall, long endElapsed, boolean gap) {
            this.id = Objects.requireNonNull(id, "id");
            this.eventId = Objects.requireNonNull(eventId, "eventId");
            this.subId = subId;
            this.phoneGE9 = phoneGE9;
            this.ringWall = ringWall;
            this.ringElapsed = ringElapsed;
            this.answerWall = answerWall;
            this.answerElapsed = answerElapsed;
            this.endWall = endWall;
            this.endElapsed = endElapsed;
            this.gap = gap;
        }
    }

    public static final class Log {
        public final long rowId;
        public final long dateWall;
        public final long durationSeconds;
        /** A verified subscription id, or -1 when the SIM cannot be established. */
        public final int subId;
        public final String phoneGE9;

        public Log(long rowId, long dateWall, long durationSeconds, int subId, String phoneGE9) {
            this.rowId = rowId;
            this.dateWall = dateWall;
            this.durationSeconds = durationSeconds;
            this.subId = subId;
            this.phoneGE9 = phoneGE9;
        }
    }

    public enum Decision { MATCH, DEFER, NEW }

    public static final class Result {
        public final Log row;
        public final Decision decision;
        /** Present only for MATCH. Persistence must independently enforce a unique 1:1 link. */
        public final Session session;

        private Result(Log row, Decision decision, Session session) {
            this.row = row;
            this.decision = decision;
            this.session = session;
        }
    }

    /**
     * Inputs must contain all unlinked answered sessions and all unlinked final rows for a scan.
     * Phones are normalized Georgian nine-digit numbers, preserved valid foreign numbers, or null.
     * The returned order follows rows.
     * NEW means no live association is plausible; the caller still validates SIM/category eligibility.
     */
    public static List<Result> reconcile(List<Session> sessions, List<Log> rows) {
        Objects.requireNonNull(sessions, "sessions");
        Objects.requireNonNull(rows, "rows");
        int[] sessionDegree = new int[sessions.size()];
        int[] rowDegree = new int[rows.size()];
        int[] onlySession = new int[rows.size()];
        boolean[] onlyEdgeStrict = new boolean[rows.size()];
        Set<String> duplicateSessions = duplicatesOfSessions(sessions);
        Set<String> duplicateRows = duplicatesOfRows(rows);

        // Keep weak edges in the graph too: a malformed/unknown row can make another match unsafe.
        for (int rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
            Log row = Objects.requireNonNull(rows.get(rowIndex), "row");
            for (int sessionIndex = 0; sessionIndex < sessions.size(); sessionIndex++) {
                Session session = Objects.requireNonNull(sessions.get(sessionIndex), "session");
                if (!possibleAssociation(session, row)) continue;
                sessionDegree[sessionIndex]++;
                rowDegree[rowIndex]++;
                onlySession[rowIndex] = sessionIndex;
                onlyEdgeStrict[rowIndex] = strictCandidate(session, row);
            }
        }

        List<Result> results = new ArrayList<>(rows.size());
        for (int rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
            Log row = rows.get(rowIndex);
            if (duplicateRows.contains(rowKey(row)) || !validLog(row)) {
                results.add(new Result(row, Decision.DEFER, null));
            } else if (rowDegree[rowIndex] == 0) {
                results.add(new Result(row, Decision.NEW, null));
            } else {
                int sessionIndex = onlySession[rowIndex];
                Session session = sessions.get(sessionIndex);
                boolean unique = rowDegree[rowIndex] == 1 && sessionDegree[sessionIndex] == 1
                        && !duplicateSessions.contains(session.id);
                results.add(unique && onlyEdgeStrict[rowIndex]
                        ? new Result(row, Decision.MATCH, session)
                        : new Result(row, Decision.DEFER, null));
            }
        }
        return Collections.unmodifiableList(results);
    }

    private static boolean possibleAssociation(Session session, Log row) {
        if (session.subId >= 0 && row.subId >= 0 && session.subId != row.subId) return false;
        // Clean, verified evidence of different callers cannot refer to the same answered session.
        if (!session.gap && session.subId >= 0 && row.subId == session.subId
                && session.phoneGE9 != null && row.phoneGE9 != null
                && !session.phoneGE9.equals(row.phoneGE9)) return false;
        if (session.ringWall < 0 || row.dateWall < 0) return false;
        long latestStart = Math.max(session.ringWall, session.answerWall);
        return row.dateWall >= addSaturated(session.ringWall, -POSSIBLE_EARLY_MS)
                && row.dateWall <= addSaturated(latestStart, POSSIBLE_LATE_MS);
    }

    private static boolean strictCandidate(Session session, Log row) {
        if (!validLog(row) || session.subId < 0 || row.subId != session.subId) return false;
        if (session.ringElapsed < 0 || session.answerElapsed < session.ringElapsed
                || session.answerWall < 0) return false;
        if (session.phoneGE9 != null && row.phoneGE9 != null
                && !session.phoneGE9.equals(row.phoneGE9)) return false;
        if (row.dateWall < addSaturated(session.ringWall, -START_EARLY_MS)
                || row.dateWall > addSaturated(session.ringWall, START_LATE_MS)
                || row.dateWall > addSaturated(session.answerWall, START_LATE_MS)) return false;

        if (session.gap) {
            return session.phoneGE9 != null && session.phoneGE9.equals(row.phoneGE9);
        }
        // A clean session without an end is still active; its final row cannot be established yet.
        if (session.endWall < 0 || session.endElapsed < session.answerElapsed) return false;
        long talkMillis = session.endElapsed - session.answerElapsed;
        long logMillis = row.durationSeconds * 1_000;
        // DATE is the ringing start. Wall-clock end and DATE + DURATION are deliberately unused.
        return logMillis >= addSaturated(talkMillis, -DURATION_TOLERANCE_MS)
                && logMillis <= addSaturated(talkMillis, DURATION_TOLERANCE_MS);
    }

    private static boolean validLog(Log row) {
        return row.dateWall >= 0 && row.durationSeconds >= 0
                && row.durationSeconds <= Long.MAX_VALUE / 1_000;
    }

    private static Set<String> duplicatesOfSessions(List<Session> sessions) {
        Set<String> seen = new HashSet<>();
        Set<String> duplicates = new HashSet<>();
        Set<String> seenEventIds = new HashSet<>();
        Set<String> duplicateEventIds = new HashSet<>();
        for (Session session : sessions) {
            Objects.requireNonNull(session, "session");
            if (!seen.add(session.id)) duplicates.add(session.id);
            if (!seenEventIds.add(session.eventId)) duplicateEventIds.add(session.eventId);
        }
        for (Session session : sessions) {
            if (duplicateEventIds.contains(session.eventId)) duplicates.add(session.id);
        }
        return duplicates;
    }

    private static Set<String> duplicatesOfRows(List<Log> rows) {
        Set<String> seen = new HashSet<>();
        Set<String> duplicates = new HashSet<>();
        for (Log row : rows) {
            Objects.requireNonNull(row, "row");
            String key = rowKey(row);
            if (!seen.add(key)) duplicates.add(key);
        }
        return duplicates;
    }

    private static String rowKey(Log row) { return row.rowId + ":" + row.dateWall; }

    private static long addSaturated(long value, long offset) {
        if (offset > 0 && value > Long.MAX_VALUE - offset) return Long.MAX_VALUE;
        if (offset < 0 && value < Long.MIN_VALUE - offset) return Long.MIN_VALUE;
        return value + offset;
    }
}
