package ge.greentaxi.calls;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class TelecomSnapshotTest {
    private static int assertions;
    private static final long CREATED = 1_000_000;
    private static final String PHONE = "599123456";
    private static TelecomSnapshot snapshot(String id, String account, long creation, long connect, TelecomSnapshot.State state) {
        return new TelecomSnapshot(id, account, 1, PHONE, creation, connect, creation + 20_000, 60_000, state);
    }
    public static void main(String[] args) {
        identitySurvivesRebindAndSeparatesReusedIds();
        onlyIndividualAnswerEvidenceQualifies();
        overlappingCallsReconcileIndependently();
        unknownOrDuplicateEvidenceRemainsConservative();
        ringingReservationCanRecoverFromFinalAcceptedRow();
        System.out.println("TelecomSnapshotTest passed (" + assertions + " assertions)");
    }
    private static void identitySurvivesRebindAndSeparatesReusedIds() {
        TelecomSnapshot ring = snapshot("TC@1", "account-A", CREATED, 0, TelecomSnapshot.State.RINGING);
        TelecomSnapshot rebound = snapshot("TC@1", "account-A", CREATED, CREATED + 5_000, TelecomSnapshot.State.HOLDING);
        check(ring.sessionKey.equals(rebound.sessionKey), "rebind and answer never change durable identity");
        check(!ring.sessionKey.equals(snapshot("TC@1", "account-A", CREATED + 1, 0, TelecomSnapshot.State.RINGING).sessionKey), "reused Telecom ID after reboot needs creation time");
        check(!ring.sessionKey.equals(snapshot("TC@1", "account-B", CREATED, 0, TelecomSnapshot.State.RINGING).sessionKey), "SIM account isolates identity");
        check(!ring.sessionKey.equals(snapshot("TC@2", "account-A", CREATED, 0, TelecomSnapshot.State.RINGING).sessionKey), "parallel Call objects isolate identity");
        check(TelecomSnapshot.isTelecomSession(ring.sessionKey), "bounded hash identity is recognized");
        check(!TelecomSnapshot.isTelecomSession("telecom:TC@1"), "untrusted prefix alone is insufficient");
        check(!ring.sessionKey.contains("account") && !ring.sessionKey.contains("TC@1"), "raw Telecom and account IDs are not persisted");
        try { snapshot("", "account", CREATED, 0, TelecomSnapshot.State.ACTIVE); throw new AssertionError("missing ID accepted"); }
        catch (IllegalArgumentException expected) { assertions++; }
        try { snapshot("TC@1", "account", 0, 0, TelecomSnapshot.State.ACTIVE); throw new AssertionError("missing creation accepted"); }
        catch (IllegalArgumentException expected) { assertions++; }
    }
    private static void onlyIndividualAnswerEvidenceQualifies() {
        check(!snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.RINGING).accepted(), "ringing is never accepted");
        check(!snapshot("1", "a", CREATED, CREATED + 5_000, TelecomSnapshot.State.RINGING).accepted(), "inconsistent ringing connect timestamp cannot guess acceptance");
        check(snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.ACTIVE).accepted(), "ACTIVE is the immediate authoritative answer event");
        check(!snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.HOLDING).accepted(), "held state without connect evidence stays unproven");
        check(snapshot("1", "a", CREATED, CREATED + 5_000, TelecomSnapshot.State.HOLDING).accepted(), "held recovery has positive connect proof");
        check(!snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.ENDED).accepted(), "rejected or missed call emits nothing");
        check(!snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.UNANSWERED).accepted(), "definitively missed or rejected call never qualifies");
        check(snapshot("1", "a", CREATED, CREATED + 5_000, TelecomSnapshot.State.ENDED).accepted(), "disconnected recovery retains accepted proof");
    }
    private static CallReconciler.Session session(TelecomSnapshot snapshot, String phone, boolean answered) {
        return new CallReconciler.Session(snapshot.sessionKey, "event-" + snapshot.sessionKey, 1, phone,
                snapshot.createdAt, 1_000, answered ? snapshot.createdAt + 5_000 : -1,
                answered ? 6_000 : -1, -1, -1, false);
    }
    private static CallReconciler.Log row(long id, long date, String phone) { return new CallReconciler.Log(id, date, 10, 1, phone); }
    private static void overlappingCallsReconcileIndependently() {
        TelecomSnapshot first = snapshot("1", "a", CREATED, CREATED + 3_000, TelecomSnapshot.State.ACTIVE);
        TelecomSnapshot waiting = snapshot("2", "a", CREATED + 7_000, CREATED + 8_000, TelecomSnapshot.State.ACTIVE);
        CallReconciler.Session a = session(first, PHONE, true);
        CallReconciler.Session b = session(waiting, "599654321", true);
        List<CallReconciler.Result> result = CallReconciler.reconcile(Arrays.asList(a, b), Arrays.asList(row(1, CREATED, PHONE), row(2, CREATED + 7_000, "599654321")));
        check(result.get(0).decision == CallReconciler.Decision.MATCH && result.get(0).session == a, "first same-SIM call preserves its event");
        check(result.get(1).decision == CallReconciler.Decision.MATCH && result.get(1).session == b, "accepted waiting call preserves its own event");
        // Even a rapid repeat from the same number can anchor its exact creation timestamp.
        b = session(waiting, PHONE, true);
        result = CallReconciler.reconcile(Arrays.asList(a, b), Arrays.asList(row(1, CREATED, PHONE), row(2, CREATED + 7_000, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.MATCH && result.get(0).session == a
                && result.get(1).decision == CallReconciler.Decision.MATCH && result.get(1).session == b,
                "rapid same-caller calls preserve their unique authoritative creation anchors");
        CallReconciler.Session missedReservation = session(first, PHONE, false);
        result = CallReconciler.reconcile(Arrays.asList(missedReservation, b), Collections.singletonList(row(2, CREATED + 7_000, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.MATCH && result.get(0).session == b,
                "missed earlier call cannot permanently block accepted same-caller retry");
        result = CallReconciler.reconcile(Collections.singletonList(a), Arrays.asList(row(1, CREATED, PHONE), row(2, CREATED + 7_000, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.MATCH && result.get(1).decision == CallReconciler.Decision.DEFER, "unique exact anchor commits before nearby fallback row");
        result = CallReconciler.reconcile(Collections.emptyList(), Collections.singletonList(row(2, CREATED + 7_000, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.NEW, "after persisted anchor removes session, next journal row recovers");
    }
    private static void unknownOrDuplicateEvidenceRemainsConservative() {
        CallReconciler.Session a = session(snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.RINGING), PHONE, true);
        List<CallReconciler.Result> result = CallReconciler.reconcile(Collections.singletonList(a), Arrays.asList(row(1, CREATED, PHONE), row(2, CREATED + 7_000, null)));
        check(result.get(0).decision == CallReconciler.Decision.DEFER && result.get(1).decision == CallReconciler.Decision.DEFER, "unknown phone blocks anchor pruning");
        result = CallReconciler.reconcile(Collections.singletonList(a), Arrays.asList(row(1, CREATED, PHONE), row(1, CREATED, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.DEFER && result.get(1).decision == CallReconciler.Decision.DEFER, "duplicate journal identity blocks all matching");
        result = CallReconciler.reconcile(Collections.singletonList(a), Collections.singletonList(new CallReconciler.Log(1, CREATED, 10, -1, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.DEFER, "unknown SIM cannot match authoritative call");
    }
    private static void ringingReservationCanRecoverFromFinalAcceptedRow() {
        CallReconciler.Session reservation = session(snapshot("1", "a", CREATED, 0, TelecomSnapshot.State.RINGING), PHONE, false);
        List<CallReconciler.Result> result = CallReconciler.reconcile(Collections.singletonList(reservation), Collections.singletonList(row(1, CREATED, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.MATCH, "final INCOMING row proves acceptance after callback process death");
        result = CallReconciler.reconcile(Collections.singletonList(reservation), Collections.singletonList(row(1, CREATED + 1, PHONE)));
        check(result.get(0).decision == CallReconciler.Decision.DEFER, "telecom exact creation is not replaced by a guessed time");
        reservation = session(snapshot("2", "a", CREATED, 0, TelecomSnapshot.State.RINGING), null, false);
        result = CallReconciler.reconcile(Collections.singletonList(reservation), Collections.singletonList(row(1, CREATED, null)));
        check(result.get(0).decision == CallReconciler.Decision.MATCH, "unique exact creation and verified SIM recover hidden caller");
    }
    private static void check(boolean value, String message) { assertions++; if (!value) throw new AssertionError(message); }
}
