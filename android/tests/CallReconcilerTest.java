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
        finalUnansweredKindsKeepTheEarlyIdentity();
        allIncomingOverlapUsesKnownCallerEvidence();
        allIncomingAmbiguityStaysUnresolved();
        legacyGapAnchorsSettleBeforeDifferentCallerFallback();
        prePolicyRowsCannotConsumeNewReservations();
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

    private static void finalUnansweredKindsKeepTheEarlyIdentity() {
        CallReconciler.Session ringing = reservation("ring", PHONE, BASE, false);
        for (String kind : Arrays.asList(CallReconciler.MISSED, CallReconciler.REJECTED)) {
            CallReconciler.Result result = reconcile(ringing, kindRow(30, BASE, 0, 1, PHONE, kind));
            decision(result, CallReconciler.Decision.MATCH);
            same(result.session, ringing, "unanswered final updates the ringing identity");
            equal(result.row.kind, kind, "final journal outcome is retained");
        }
        decision(reconcile(ringing, kindRow(31, BASE, 3, 1, PHONE, CallReconciler.INCOMING)),
                CallReconciler.Decision.MATCH);
        // A final accepted row is authoritative even if no individual OFFHOOK was safe to use.
        CallReconciler.Session interrupted = reservation("interrupted", PHONE, BASE, true);
        decision(reconcile(interrupted, kindRow(31, BASE, 600, 1, PHONE, CallReconciler.INCOMING)),
                CallReconciler.Decision.MATCH);
        decision(reconcile(interrupted, kindRow(32, BASE, 0, 1, PHONE, CallReconciler.MISSED)),
                CallReconciler.Decision.MATCH);
        decision(reconcile(reservation("hidden", null, BASE, false),
                kindRow(33, BASE, 0, 1, null, CallReconciler.REJECTED)), CallReconciler.Decision.MATCH);
        decision(reconcile(reservation("hidden", null, BASE, false),
                kindRow(34, BASE, 0, 1, PHONE, CallReconciler.MISSED)), CallReconciler.Decision.MATCH);
        decision(reconcile(ringing, kindRow(35, BASE, 14, 1, PHONE, CallReconciler.INCOMING)),
                CallReconciler.Decision.DEFER);
        decision(reconcile(ringing, kindRow(36, BASE - 10_000, 0, 1, PHONE, CallReconciler.MISSED)),
                CallReconciler.Decision.MATCH);
        decision(reconcile(ringing, kindRow(37, BASE - 10_001, 0, 1, PHONE, CallReconciler.MISSED)),
                CallReconciler.Decision.DEFER);
        decision(reconcile(ringing, kindRow(38, BASE + 2_000, 0, 1, PHONE, CallReconciler.REJECTED)),
                CallReconciler.Decision.MATCH);
        decision(reconcile(ringing, kindRow(39, BASE + 2_001, 0, 1, PHONE, CallReconciler.REJECTED)),
                CallReconciler.Decision.DEFER);
    }

    private static void allIncomingOverlapUsesKnownCallerEvidence() {
        String other = "599654321";
        CallReconciler.Session first = new CallReconciler.Session("first-all", "event-first-all", 1, PHONE,
                BASE, 1_000, BASE + 3_000, 4_000, -1, -1, true, true);
        CallReconciler.Session waiting = reservation("waiting", other, BASE + 7_000, true);
        for (String kind : Arrays.asList(CallReconciler.INCOMING, CallReconciler.MISSED, CallReconciler.REJECTED)) {
            CallReconciler.Log firstRow = kindRow(41, BASE, 20, 1, PHONE, CallReconciler.INCOMING);
            CallReconciler.Log secondRow = kindRow(42, BASE + 7_000,
                    CallReconciler.INCOMING.equals(kind) ? 7 : 0, 1, other, kind);
            List<CallReconciler.Result> result = CallReconciler.reconcile(Arrays.asList(first, waiting), Arrays.asList(firstRow, secondRow));
            decision(result.get(0), CallReconciler.Decision.MATCH);
            decision(result.get(1), CallReconciler.Decision.MATCH);
            same(result.get(0).session, first, "first known caller remains separate");
            same(result.get(1).session, waiting, "waiting final updates its own early card");
            result = CallReconciler.reconcile(Arrays.asList(waiting, first), Arrays.asList(secondRow, firstRow));
            same(result.get(0).session, waiting, "reversing inputs preserves waiting association");
            same(result.get(1).session, first, "reversing inputs preserves first association");
        }
        List<CallReconciler.Result> fallback = CallReconciler.reconcile(Arrays.asList(first),
                Arrays.asList(kindRow(41, BASE, 20, 1, PHONE, CallReconciler.INCOMING),
                        kindRow(42, BASE + 7_000, 0, 1, other, CallReconciler.MISSED)));
        decision(fallback.get(0), CallReconciler.Decision.MATCH);
        decision(fallback.get(1), CallReconciler.Decision.NEW);
    }

    private static void allIncomingAmbiguityStaysUnresolved() {
        CallReconciler.Session ringing = reservation("ring", PHONE, BASE, false);
        decision(reconcile(ringing, kindRow(50, BASE, 0, -1, PHONE, CallReconciler.MISSED)),
                CallReconciler.Decision.DEFER);
        decision(reconcile(reservation("gap-hidden", null, BASE, true),
                kindRow(51, BASE, 0, 1, PHONE, CallReconciler.REJECTED)), CallReconciler.Decision.DEFER);
        CallReconciler.Session answered = new CallReconciler.Session("answered-all", "event-answered-all", 1, PHONE,
                BASE, 1_000, BASE + 3_000, 4_000, BASE + 10_000, 11_000, false, true);
        for (String kind : Arrays.asList(CallReconciler.MISSED, CallReconciler.REJECTED)) {
            CallReconciler.Result corrected = reconcile(answered, kindRow(52, BASE, 0, 1, PHONE, kind));
            decision(corrected, CallReconciler.Decision.MATCH);
            same(corrected.session, answered, "journal corrects a provisional aggregate answer on the same card");
            decision(reconcile(session("legacy-proven", 1, PHONE, BASE, 10, true),
                    kindRow(52, BASE, 0, 1, PHONE, kind)), CallReconciler.Decision.DEFER);
        }
        for (String kind : Arrays.asList("outgoing", "unexpected", null)) {
            decision(CallReconciler.reconcile(Collections.emptyList(),
                    Arrays.asList(kindRow(53, BASE, 0, 1, PHONE, kind))).get(0), CallReconciler.Decision.DEFER);
        }
        decision(reconcile(ringing, kindRow(54, BASE, 1, 1, PHONE, CallReconciler.REJECTED)),
                CallReconciler.Decision.DEFER);
        CallReconciler.Session second = reservation("same-caller-again", PHONE, BASE + 7_000, true);
        allDeferred(CallReconciler.reconcile(Arrays.asList(ringing, second),
                Arrays.asList(kindRow(55, BASE, 0, 1, PHONE, CallReconciler.MISSED),
                        kindRow(56, BASE + 7_000, 0, 1, PHONE, CallReconciler.MISSED))));
        allDeferred(CallReconciler.reconcile(Arrays.asList(ringing),
                Arrays.asList(kindRow(55, BASE, 0, 1, PHONE, CallReconciler.MISSED),
                        kindRow(55, BASE, 0, 1, PHONE, CallReconciler.MISSED))));
    }

    private static void legacyGapAnchorsSettleBeforeDifferentCallerFallback() {
        CallReconciler.Session old = session("old-gap", 1, PHONE, BASE, 20, true);
        CallReconciler.Log accepted = row(60, BASE, 20, 1, PHONE);
        CallReconciler.Log missed = kindRow(61, BASE + 7_000, 0, 1, "599654321", CallReconciler.MISSED);
        List<CallReconciler.Result> result = CallReconciler.reconcile(Arrays.asList(old), Arrays.asList(accepted, missed));
        decision(result.get(0), CallReconciler.Decision.MATCH);
        decision(result.get(1), CallReconciler.Decision.DEFER);
        same(result.get(0).session, old, "old accepted event settles before nearby missed caller");
        decision(CallReconciler.reconcile(Collections.emptyList(), Arrays.asList(missed)).get(0),
                CallReconciler.Decision.NEW);
        // A hidden or unknown-SIM neighbour cannot be pruned as a different caller.
        allDeferred(CallReconciler.reconcile(Arrays.asList(old), Arrays.asList(accepted,
                kindRow(62, BASE + 7_000, 0, 1, null, CallReconciler.MISSED))));
        allDeferred(CallReconciler.reconcile(Arrays.asList(old), Arrays.asList(accepted,
                kindRow(63, BASE + 7_000, 0, -1, "599654321", CallReconciler.MISSED))));
    }

    private static void prePolicyRowsCannotConsumeNewReservations() {
        // The old call started a second before activation; a fresh call from the
        // same number starts at activation while the old journal row is delayed.
        CallReconciler.Log oldIncoming = new CallReconciler.Log(70, BASE - 1_000, 3, 1,
                PHONE, CallReconciler.INCOMING, false);
        CallReconciler.Session fresh = reservation("fresh-policy", PHONE, BASE, false);
        CallReconciler.Result result = reconcile(fresh, oldIncoming);
        decision(result, CallReconciler.Decision.NEW);
        equal(result.session, null, "old incoming cannot consume the new provisional identity");

        // Pre-policy rows keep the old accepted-only recovery route, including a
        // retained legacy session, instead of being imported as new-policy calls.
        CallReconciler.Session legacy = session("retained-legacy", 1, PHONE, BASE - 1_000, 3, false);
        result = CallReconciler.reconcile(Arrays.asList(fresh, legacy), Arrays.asList(oldIncoming)).get(0);
        decision(result, CallReconciler.Decision.MATCH);
        same(result.session, legacy, "late accepted row keeps its old session identity");
        result = CallReconciler.reconcile(Collections.emptyList(), Arrays.asList(oldIncoming)).get(0);
        decision(result, CallReconciler.Decision.NEW);

        CallReconciler.Log currentIncoming = new CallReconciler.Log(71, BASE, 3, 1,
                PHONE, CallReconciler.INCOMING, true);
        List<CallReconciler.Result> mixed = CallReconciler.reconcile(Arrays.asList(fresh),
                Arrays.asList(oldIncoming, currentIncoming));
        decision(mixed.get(0), CallReconciler.Decision.NEW);
        decision(mixed.get(1), CallReconciler.Decision.MATCH);
        same(mixed.get(1).session, fresh, "new final row still updates the fresh card");

        for (String kind : Arrays.asList(CallReconciler.MISSED, CallReconciler.REJECTED)) {
            result = reconcile(fresh, new CallReconciler.Log(72, BASE, 0, 1, PHONE, kind, true));
            decision(result, CallReconciler.Decision.MATCH);
            result = reconcile(fresh, new CallReconciler.Log(73, BASE - 1_000, 0, 1, PHONE, kind, false));
            decision(result, CallReconciler.Decision.NEW);
        }
        equal(row(74, BASE, 3, 1, PHONE).allIncomingEligible, true,
                "legacy constructor keeps the existing matcher test contract");
        equal(kindRow(75, BASE, 0, 1, PHONE, CallReconciler.MISSED).allIncomingEligible, true,
                "typed constructor remains policy-eligible by default");
    }

    private static CallReconciler.Session reservation(String id, String phone, long ring, boolean gap) {
        return new CallReconciler.Session(id, "event-" + id, 1, phone, ring, 1_000, -1, -1,
                gap ? -1 : ring + 10_000, gap ? -1 : 11_000, gap, true);
    }

    private static CallReconciler.Log kindRow(long id, long date, long duration, int sub, String phone, String kind) {
        return new CallReconciler.Log(id, date, duration, sub, phone, kind);
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
