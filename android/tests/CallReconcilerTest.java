package ge.greentaxi.calls;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Run with javac/java; requires neither an Android runtime nor JUnit. */
public final class CallReconcilerTest {
    private static final long BASE = 1_000_000;
    private static final String PHONE = "599123456";
    private static int assertions;

    public static void main(String[] args) {
        uniqueCleanCompletion();
        consecutiveCallsKeepSeparateIds();
        ambiguousGraphsStayUnresolved();
        hiddenPhonesCanOnlyRefineCleanSessions();
        interruptedSessionsNeedExactKnownPhones();
        durationsUseMonotonicTalkTime();
        uncertainEvidenceNeverCreatesASecondCard();
        startWindowsAndUnknownSim();
        duplicateIdentitiesStayUnresolved();
        System.out.println("CallReconcilerTest passed (" + assertions + " assertions)");
    }

    private static void uniqueCleanCompletion() {
        CallReconciler.Session session = session("a", 1, PHONE, BASE, 10, false);
        CallReconciler.Log row = row(101, BASE, 10, 1, PHONE);
        CallReconciler.Result result = reconcile(session, row);
        decision(result, CallReconciler.Decision.MATCH);
        same(result.session, session, "matched original live session");
        equal(result.session.eventId, "event-a", "live event identity survives reconciliation");
        same(result.row, row, "original log row returned");
        decision(CallReconciler.reconcile(Collections.emptyList(), Arrays.asList(row)).get(0),
                CallReconciler.Decision.NEW);
    }

    private static void consecutiveCallsKeepSeparateIds() {
        CallReconciler.Session first = session("first", 1, PHONE, BASE, 10, false);
        CallReconciler.Session second = session("second", 1, PHONE, BASE + 60_000, 10, false);
        List<CallReconciler.Result> results = CallReconciler.reconcile(Arrays.asList(first, second),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 60_000, 10, 1, PHONE)));
        decision(results.get(0), CallReconciler.Decision.MATCH);
        decision(results.get(1), CallReconciler.Decision.MATCH);
        same(results.get(0).session, first, "first call retains first UUID");
        same(results.get(1).session, second, "second call retains second UUID");
        List<CallReconciler.Result> reversed = CallReconciler.reconcile(Arrays.asList(second, first),
                Arrays.asList(row(2, BASE + 60_000, 10, 1, PHONE), row(1, BASE, 10, 1, PHONE)));
        same(reversed.get(0).session, second, "input order cannot change association");
        same(reversed.get(1).session, first, "input order cannot change association");

        // Ten-second separation is deliberately unresolved within the conservative guard interval.
        allDeferred(CallReconciler.reconcile(Arrays.asList(first,
                session("close", 1, PHONE, BASE + 10_000, 10, false)),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 10_000, 10, 1, PHONE))));
        String otherPhone = "599654321";
        CallReconciler.Session otherCaller = session("other-caller", 1, otherPhone, BASE + 10_000, 10, false);
        List<CallReconciler.Result> differentCallers = CallReconciler.reconcile(Arrays.asList(first, otherCaller),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 10_000, 10, 1, otherPhone)));
        decision(differentCallers.get(0), CallReconciler.Decision.MATCH);
        decision(differentCallers.get(1), CallReconciler.Decision.MATCH);
        same(differentCallers.get(0).session, first, "close known caller keeps first identity");
        same(differentCallers.get(1).session, otherCaller, "close different caller keeps separate identity");
    }

    private static void ambiguousGraphsStayUnresolved() {
        CallReconciler.Session a = session("a", 1, PHONE, BASE, 10, false);
        CallReconciler.Session b = session("b", 1, PHONE, BASE + 1_000, 10, false);
        allDeferred(CallReconciler.reconcile(Arrays.asList(a, b),
                Arrays.asList(row(1, BASE, 10, 1, PHONE))));
        allDeferred(CallReconciler.reconcile(Arrays.asList(a),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 1_000, 10, 1, PHONE))));
        allDeferred(CallReconciler.reconcile(Arrays.asList(a, b),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 2_000, 10, 1, PHONE))));

        // A weak row also blocks a seemingly unique strict edge on the same live session.
        allDeferred(CallReconciler.reconcile(Arrays.asList(a),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 3_000, 10, 1, PHONE))));
    }

    private static void hiddenPhonesCanOnlyRefineCleanSessions() {
        CallReconciler.Session hidden = session("hidden", 1, null, BASE, 10, false);
        decision(reconcile(hidden, row(1, BASE, 10, 1, PHONE)), CallReconciler.Decision.MATCH);
        equal(hidden.phoneGE9, null, "matcher never mutates the live phone");
        decision(reconcile(session("known", 1, PHONE, BASE, 10, false),
                row(1, BASE, 10, 1, null)), CallReconciler.Decision.MATCH);
        decision(reconcile(hidden, row(1, BASE, 10, 1, null)), CallReconciler.Decision.MATCH);
        decision(reconcile(session("known", 1, PHONE, BASE, 10, false),
                row(1, BASE, 10, 1, "599654321")), CallReconciler.Decision.NEW);
    }

    private static void interruptedSessionsNeedExactKnownPhones() {
        decision(reconcile(session("gap", 1, PHONE, BASE, 10, true),
                row(1, BASE, 999, 1, PHONE)), CallReconciler.Decision.MATCH);
        decision(reconcile(session("gap-hidden", 1, null, BASE, 10, true),
                row(1, BASE, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session("gap", 1, PHONE, BASE, 10, true),
                row(1, BASE, 10, 1, null)), CallReconciler.Decision.DEFER);
        decision(reconcile(session("gap", 1, PHONE, BASE, 10, true),
                row(1, BASE, 10, 1, "599654321")), CallReconciler.Decision.DEFER);
        CallReconciler.Session noEnd = new CallReconciler.Session("no-end", "event-no-end", 1, PHONE,
                BASE, 1_000, BASE + 5_000, 6_000, -1, -1, false);
        decision(reconcile(noEnd, row(1, BASE, 999, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(noEnd, row(1, BASE, 10, 1, null)), CallReconciler.Decision.DEFER);
        CallReconciler.Session gapNoEnd = new CallReconciler.Session("gap-no-end", "event-gap", 1, PHONE,
                BASE, 1_000, BASE + 5_000, 6_000, -1, -1, true);
        decision(reconcile(gapNoEnd, row(1, BASE, 999, 1, PHONE)), CallReconciler.Decision.MATCH);
        CallReconciler.Session hiddenNoEnd = new CallReconciler.Session("hidden-no-end", "event-hidden", 1, null,
                BASE, 1_000, BASE + 5_000, 6_000, -1, -1, false);
        decision(reconcile(hiddenNoEnd, row(1, BASE, 10, 1, null)), CallReconciler.Decision.DEFER);
    }

    private static void durationsUseMonotonicTalkTime() {
        CallReconciler.Session session = session("a", 1, PHONE, BASE, 10, false);
        decision(reconcile(session, row(1, BASE, 7, 1, PHONE)), CallReconciler.Decision.MATCH);
        decision(reconcile(session, row(1, BASE, 13, 1, PHONE)), CallReconciler.Decision.MATCH);
        decision(reconcile(session, row(1, BASE, 6, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE, 14, 1, PHONE)), CallReconciler.Decision.DEFER);
        // Ringing took five seconds: DATE + DURATION differs from the actual end by five seconds.
        decision(reconcile(session, row(1, BASE, 10, 1, PHONE)), CallReconciler.Decision.MATCH);
        CallReconciler.Session changedWallClock = new CallReconciler.Session("wall", "event-wall", 1, PHONE,
                BASE, 1_000, BASE + 5_000, 6_000, BASE + 3_600_000, 16_000, false);
        decision(reconcile(changedWallClock, row(1, BASE, 10, 1, PHONE)), CallReconciler.Decision.MATCH);
        CallReconciler.Session badEnd = new CallReconciler.Session("bad-end", "event-bad", 1, PHONE,
                BASE, 1_000, BASE + 5_000, 6_000, BASE + 10_000, 5_000, false);
        decision(reconcile(badEnd, row(1, BASE, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
    }

    private static void uncertainEvidenceNeverCreatesASecondCard() {
        CallReconciler.Session session = session("a", 1, PHONE, BASE, 10, false);
        decision(reconcile(session, row(1, BASE + 3_000, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE + 5_000, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE - 20_000, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE, 10, 1, "599654321")), CallReconciler.Decision.NEW);
        decision(reconcile(session, row(1, BASE + 60_000, 10, 1, PHONE)), CallReconciler.Decision.NEW);
        decision(reconcile(session, row(1, BASE, -1, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(CallReconciler.reconcile(Collections.emptyList(),
                Arrays.asList(row(1, BASE, -1, 1, PHONE))).get(0), CallReconciler.Decision.DEFER);
    }

    private static void startWindowsAndUnknownSim() {
        CallReconciler.Session session = session("a", 1, PHONE, BASE, 10, false);
        decision(reconcile(session, row(1, BASE - 10_000, 10, 1, PHONE)), CallReconciler.Decision.MATCH);
        decision(reconcile(session, row(1, BASE - 10_001, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE + 2_000, 10, 1, PHONE)), CallReconciler.Decision.MATCH);
        decision(reconcile(session, row(1, BASE + 2_001, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE, 10, -1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session("unknown", -1, PHONE, BASE, 10, false),
                row(1, BASE, 10, 1, PHONE)), CallReconciler.Decision.DEFER);
        decision(reconcile(session("unknown", -1, PHONE, BASE, 10, false),
                row(1, BASE, 10, 1, "599654321")), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE, 10, -1, "599654321")), CallReconciler.Decision.DEFER);
        decision(reconcile(session, row(1, BASE, 10, 2, PHONE)), CallReconciler.Decision.NEW);
        CallReconciler.Session clockMovedBeforeAnswer = new CallReconciler.Session("clock", "event-clock", 1, PHONE,
                BASE, 1_000, BASE - 2_000, 6_000, BASE + 10_000, 16_000, false);
        decision(reconcile(clockMovedBeforeAnswer, row(1, BASE + 1_000, 10, 1, PHONE)),
                CallReconciler.Decision.DEFER);
        allDeferred(CallReconciler.reconcile(Arrays.asList(session,
                session("unknown", -1, null, BASE, 10, false)),
                Arrays.asList(row(1, BASE, 10, 1, PHONE))));
    }

    private static void duplicateIdentitiesStayUnresolved() {
        allDeferred(CallReconciler.reconcile(Arrays.asList(session("same", 1, PHONE, BASE, 10, false),
                session("same", 1, PHONE, BASE + 60_000, 10, false)),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 60_000, 10, 1, PHONE))));
        allDeferred(CallReconciler.reconcile(Collections.emptyList(),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(1, BASE, 10, 1, PHONE))));
        CallReconciler.Session sharedEvent = new CallReconciler.Session("other-id", "event-a", 1, PHONE,
                BASE + 60_000, 1_000, BASE + 65_000, 6_000, BASE + 75_000, 16_000, false);
        allDeferred(CallReconciler.reconcile(Arrays.asList(session("a", 1, PHONE, BASE, 10, false), sharedEvent),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(2, BASE + 60_000, 10, 1, PHONE))));
        // Call-log row ids can be reused; identity includes the date.
        List<CallReconciler.Result> reused = CallReconciler.reconcile(Arrays.asList(
                session("a", 1, PHONE, BASE, 10, false),
                session("b", 1, PHONE, BASE + 60_000, 10, false)),
                Arrays.asList(row(1, BASE, 10, 1, PHONE), row(1, BASE + 60_000, 10, 1, PHONE)));
        decision(reused.get(0), CallReconciler.Decision.MATCH);
        decision(reused.get(1), CallReconciler.Decision.MATCH);
    }

    private static CallReconciler.Session session(String id, int sub, String phone, long ring, long talkSeconds, boolean gap) {
        return new CallReconciler.Session(id, "event-" + id, sub, phone,
                ring, 1_000, ring + 5_000, 6_000, ring + 5_000 + talkSeconds * 1_000,
                6_000 + talkSeconds * 1_000, gap);
    }

    private static CallReconciler.Log row(long id, long date, long duration, int sub, String phone) {
        return new CallReconciler.Log(id, date, duration, sub, phone);
    }

    private static CallReconciler.Result reconcile(CallReconciler.Session session, CallReconciler.Log row) {
        return CallReconciler.reconcile(Arrays.asList(session), Arrays.asList(row)).get(0);
    }

    private static void allDeferred(List<CallReconciler.Result> results) {
        for (CallReconciler.Result result : results) decision(result, CallReconciler.Decision.DEFER);
    }

    private static void decision(CallReconciler.Result result, CallReconciler.Decision expected) {
        equal(result.decision, expected, "decision for log " + result.row.rowId);
        if (expected != CallReconciler.Decision.MATCH) equal(result.session, null, "unresolved row has no link");
    }

    private static void same(Object actual, Object expected, String message) {
        assertions++;
        if (actual != expected) throw new AssertionError(message);
    }

    private static void equal(Object actual, Object expected, String message) {
        assertions++;
        if (actual == null ? expected != null : !actual.equals(expected)) {
            throw new AssertionError(message + ": expected " + expected + ", got " + actual);
        }
    }
}
