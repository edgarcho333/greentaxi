package ge.greentaxi.calls;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Run with run-live-state-tests.sh; no Android runtime or test dependencies. */
public final class LiveCallStateTest {
    private static final long EPOCH = 1_700_000_000_000L;
    private static int passed;

    public static void main(String[] args) {
        run("answered call preserves identity and captured times", LiveCallStateTest::answered);
        run("duplicate snapshots enrich without erasing number", LiveCallStateTest::duplicates);
        run("hidden caller can be answered", LiveCallStateTest::hidden);
        run("missed and rejected calls do not answer", LiveCallStateTest::missed);
        run("outgoing and rejected call waiting do not answer", LiveCallStateTest::outgoingAndWaiting);
        run("registration snapshots cannot prove answer", LiveCallStateTest::initialSnapshots);
        run("all subscriptions require initial idle", LiveCallStateTest::initialDualSim);
        run("either SIM can answer independently", LiveCallStateTest::eitherSim);
        run("simultaneous ringing abandons both candidates", LiveCallStateTest::concurrentRinging);
        run("another offhook subscription prevents answer", LiveCallStateTest::otherOffhook);
        run("different known caller makes a session ambiguous", LiveCallStateTest::conflictingPhone);
        run("answered call waiting becomes an observation gap", LiveCallStateTest::answeredWaiting);
        run("two close calls receive separate identities", LiveCallStateTest::twoCloseCalls);
        run("fresh process does not infer a missed answer", LiveCallStateTest::restart);
        run("topology change preserves answer without claiming end", LiveCallStateTest::topology);
        run("stale callback requires new idle snapshots", LiveCallStateTest::outOfOrder);
        run("clock jumps abandon rather than invent duration", LiveCallStateTest::clockJumps);
        run("small wall clock correction preserves captured times", LiveCallStateTest::smallCorrection);
        run("removed and invalid subscriptions cannot create events", LiveCallStateTest::removed);
        System.out.println("LiveCallState: " + passed + " tests passed");
    }

    private static LiveCallState helper(Integer... subs) {
        AtomicInteger keys = new AtomicInteger();
        return new LiveCallState(Arrays.asList(subs), () -> "session-" + keys.incrementAndGet());
    }

    private static List<LiveCallState.Action> state(LiveCallState helper, int sub, int state,
            String phone, long at) {
        return helper.onState(sub, state, phone, EPOCH + at, at);
    }

    private static void idle(LiveCallState helper, int sub, long at) {
        empty(state(helper, sub, LiveCallState.IDLE, null, at));
    }

    private static void answered() {
        LiveCallState helper = helper(4);
        idle(helper, 4, 10);
        LiveCallState.Action ring = one(state(helper, 4, 1, " 555010101 ", 100), LiveCallState.Kind.RING);
        LiveCallState.Action answer = one(state(helper, 4, 2, null, 600), LiveCallState.Kind.ANSWER);
        equal(answer.sessionKey, ring.sessionKey);
        equal(answer.phone, "555010101");
        check(answer.answered);
        equal(answer.ringAt, EPOCH + 100);
        equal(answer.ringElapsed, 100L);
        equal(answer.answerAt, EPOCH + 600);
        equal(answer.answerElapsed, 600L);
        equal(answer.endAt, -1L);
        LiveCallState.Action end = one(state(helper, 4, 0, null, 5_000), LiveCallState.Kind.END);
        equal(end.sessionKey, ring.sessionKey);
        equal(end.answerElapsed, 600L);
        equal(end.endElapsed, 5_000L);
        empty(state(helper, 4, 0, null, 5_001));
    }

    private static void duplicates() {
        LiveCallState helper = helper(4);
        idle(helper, 4, 0);
        LiveCallState.Action ring = one(state(helper, 4, 1, null, 100), LiveCallState.Kind.RING);
        empty(state(helper, 4, 1, "  ", 101));
        LiveCallState.Action update = one(state(helper, 4, 1, "555010101", 102), LiveCallState.Kind.UPDATE);
        equal(update.sessionKey, ring.sessionKey);
        equal(update.ringElapsed, 100L);
        empty(state(helper, 4, 1, null, 103));
        empty(state(helper, 4, 1, "555010101", 104));
        LiveCallState.Action answer = one(state(helper, 4, 2, null, 200), LiveCallState.Kind.ANSWER);
        equal(answer.phone, "555010101");
        empty(state(helper, 4, 2, null, 200));
        empty(state(helper, 4, 2, "", 201));
        empty(state(helper, 4, 2, "555010101", 202));
    }

    private static void hidden() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, null, 10), LiveCallState.Kind.RING);
        LiveCallState.Action answer = one(state(helper, 1, 2, " ", 20), LiveCallState.Kind.ANSWER);
        equal(answer.phone, null);
        LiveCallState.Action enriched = one(state(helper, 1, 2, "555010101", 30), LiveCallState.Kind.UPDATE);
        check(enriched.answered);
        equal(enriched.answerElapsed, 20L);
        equal(enriched.phone, "555010101");
    }

    private static void missed() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, "555010101", 10), LiveCallState.Kind.RING);
        LiveCallState.Action end = one(state(helper, 1, 0, null, 20), LiveCallState.Kind.END);
        check(!end.answered);
        equal(end.answerAt, -1L);
        empty(state(helper, 1, 2, null, 21));
    }

    private static void outgoingAndWaiting() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        empty(state(helper, 1, 2, null, 10));
        empty(state(helper, 1, 1, "555010101", 20));
        empty(state(helper, 1, 2, null, 30));
        empty(state(helper, 1, 0, null, 40));
        one(state(helper, 1, 1, "555010101", 50), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 60), LiveCallState.Kind.ANSWER);
    }

    private static void initialSnapshots() {
        LiveCallState helper = helper(1);
        empty(state(helper, 1, 1, "555010101", 10));
        empty(state(helper, 1, 1, "555010101", 11));
        empty(state(helper, 1, 2, null, 20));
        idle(helper, 1, 30);
        one(state(helper, 1, 1, null, 40), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 50), LiveCallState.Kind.ANSWER);
        LiveCallState offhook = helper(1);
        empty(state(offhook, 1, 2, null, 0));
        empty(state(offhook, 1, 1, null, 10));
        empty(state(offhook, 1, 2, null, 20));
    }

    private static void initialDualSim() {
        LiveCallState helper = helper(1, 2);
        idle(helper, 1, 0);
        empty(state(helper, 1, 1, null, 10));
        idle(helper, 2, 11);
        empty(state(helper, 1, 2, null, 20));
        idle(helper, 1, 30);
        one(state(helper, 1, 1, null, 40), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 50), LiveCallState.Kind.ANSWER);
    }

    private static void eitherSim() {
        LiveCallState helper = helper(1, 2);
        idle(helper, 1, 0);
        idle(helper, 2, 1);
        LiveCallState.Action first = one(state(helper, 2, 1, "555010101", 10), LiveCallState.Kind.RING);
        equal(first.subId, 2);
        one(state(helper, 2, 2, null, 20), LiveCallState.Kind.ANSWER);
        one(state(helper, 2, 0, null, 30), LiveCallState.Kind.END);
        LiveCallState.Action second = one(state(helper, 1, 1, "555010101", 31), LiveCallState.Kind.RING);
        equal(second.subId, 1);
        check(!second.sessionKey.equals(first.sessionKey));
        one(state(helper, 1, 2, null, 32), LiveCallState.Kind.ANSWER);
    }

    private static void concurrentRinging() {
        LiveCallState helper = helper(1, 2);
        idle(helper, 1, 0);
        idle(helper, 2, 1);
        LiveCallState.Action ring = one(state(helper, 1, 1, "555010101", 10), LiveCallState.Kind.RING);
        LiveCallState.Action gap = one(state(helper, 2, 1, "555010102", 11), LiveCallState.Kind.ABANDON);
        equal(gap.sessionKey, ring.sessionKey);
        empty(state(helper, 1, 2, null, 12));
        empty(state(helper, 2, 2, null, 13));
        idle(helper, 1, 14);
        idle(helper, 2, 15);
        one(state(helper, 2, 1, null, 16), LiveCallState.Kind.RING);
        one(state(helper, 2, 2, null, 17), LiveCallState.Kind.ANSWER);
    }

    private static void otherOffhook() {
        LiveCallState helper = helper(1, 2);
        idle(helper, 1, 0);
        idle(helper, 2, 1);
        one(state(helper, 1, 1, null, 10), LiveCallState.Kind.RING);
        one(state(helper, 2, 2, null, 11), LiveCallState.Kind.ABANDON);
        empty(state(helper, 1, 2, null, 12));
        empty(state(helper, 1, 1, null, 13));
        empty(state(helper, 1, 2, null, 14));
    }

    private static void conflictingPhone() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, "555010101", 10), LiveCallState.Kind.RING);
        LiveCallState.Action gap = one(state(helper, 1, 1, "555010102", 11), LiveCallState.Kind.ABANDON);
        equal(gap.phone, "555010101");
        empty(state(helper, 1, 2, "555010102", 12));
        idle(helper, 1, 13);
        one(state(helper, 1, 1, "555010101", 14), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, "555010102", 15), LiveCallState.Kind.ABANDON);
        empty(state(helper, 1, 2, "555010102", 16));
    }

    private static void answeredWaiting() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, "555010101", 10), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 20), LiveCallState.Kind.ANSWER);
        LiveCallState.Action gap = one(state(helper, 1, 1, "555010102", 30), LiveCallState.Kind.ABANDON);
        check(gap.answered);
        equal(gap.answerAt, EPOCH + 20);
        equal(gap.endAt, -1L);
        empty(state(helper, 1, 2, null, 40));
        idle(helper, 1, 50);
    }

    private static void twoCloseCalls() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        LiveCallState.Action first = one(state(helper, 1, 1, "555010101", 10), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 11), LiveCallState.Kind.ANSWER);
        one(state(helper, 1, 0, null, 12), LiveCallState.Kind.END);
        LiveCallState.Action second = one(state(helper, 1, 1, "555010101", 13), LiveCallState.Kind.RING);
        check(!first.sessionKey.equals(second.sessionKey));
        one(state(helper, 1, 2, null, 14), LiveCallState.Kind.ANSWER);
    }

    private static void restart() {
        LiveCallState before = helper(1);
        idle(before, 1, 0);
        one(state(before, 1, 1, "555010101", 10), LiveCallState.Kind.RING);
        LiveCallState after = helper(1);
        empty(state(after, 1, 2, "555010101", 20));
        empty(state(after, 1, 2, null, 21));
        idle(after, 1, 30);
        one(state(after, 1, 1, null, 40), LiveCallState.Kind.RING);
        one(state(after, 1, 2, null, 50), LiveCallState.Kind.ANSWER);
    }

    private static void topology() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, null, 10), LiveCallState.Kind.RING);
        one(helper.setSubscriptions(Arrays.asList(1, 2), EPOCH + 11, 11), LiveCallState.Kind.ABANDON);
        empty(state(helper, 1, 2, null, 12));
        idle(helper, 1, 13);
        idle(helper, 2, 14);
        one(state(helper, 1, 1, null, 20), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 21), LiveCallState.Kind.ANSWER);
        LiveCallState.Action gap = one(helper.setSubscriptions(Collections.singletonList(1), EPOCH + 22, 22), LiveCallState.Kind.ABANDON);
        check(gap.answered);
        equal(gap.answerElapsed, 21L);
        equal(gap.endElapsed, -1L);
        empty(state(helper, 1, 2, null, 23));
        idle(helper, 1, 24);
        empty(helper.setSubscriptions(Collections.singletonList(1), EPOCH + 25, 25));
        one(state(helper, 1, 1, null, 26), LiveCallState.Kind.RING);
    }

    private static void outOfOrder() {
        LiveCallState helper = helper(1, 2);
        idle(helper, 1, 0);
        idle(helper, 2, 1);
        one(state(helper, 1, 1, null, 10), LiveCallState.Kind.RING);
        one(state(helper, 2, 0, null, 9), LiveCallState.Kind.ABANDON);
        empty(state(helper, 1, 2, null, 11));
        idle(helper, 1, 12);
        empty(state(helper, 1, 1, null, 13));
        idle(helper, 1, 14);
        idle(helper, 2, 15);
        one(state(helper, 1, 1, null, 16), LiveCallState.Kind.RING);
        one(state(helper, 1, 2, null, 17), LiveCallState.Kind.ANSWER);
    }

    private static void clockJumps() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, null, 10), LiveCallState.Kind.RING);
        LiveCallState.Action gap = one(helper.onState(1, 2, null, EPOCH + 60_020, 20), LiveCallState.Kind.ABANDON);
        equal(gap.ringAt, EPOCH + 10);
        check(!gap.answered);
        empty(helper.onState(1, 2, null, EPOCH + 60_021, 21));
        LiveCallState answered = helper(1);
        idle(answered, 1, 0);
        one(state(answered, 1, 1, null, 10), LiveCallState.Kind.RING);
        one(state(answered, 1, 2, null, 20), LiveCallState.Kind.ANSWER);
        LiveCallState.Action answeredGap = one(answered.onState(1, 0, null, EPOCH - 60_000, 30), LiveCallState.Kind.ABANDON);
        check(answeredGap.answered);
        equal(answeredGap.endAt, -1L);
        equal(answeredGap.answerAt, EPOCH + 20);
    }

    private static void smallCorrection() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        one(state(helper, 1, 1, null, 10), LiveCallState.Kind.RING);
        LiveCallState.Action answer = one(helper.onState(1, 2, null, EPOCH + 5_020, 20), LiveCallState.Kind.ANSWER);
        equal(answer.answerAt, EPOCH + 5_020);
        equal(answer.answerElapsed, 20L);
        one(helper.onState(1, 0, null, EPOCH + 5_030, 30), LiveCallState.Kind.END);
    }

    private static void removed() {
        LiveCallState helper = helper(1);
        idle(helper, 1, 0);
        empty(state(helper, 9, 1, "555010101", 10));
        empty(state(helper, 9, 2, "555010101", 11));
        empty(helper.setSubscriptions(Collections.emptyList(), EPOCH + 20, 20));
        empty(state(helper, 1, 1, null, 21));
        empty(state(helper, 1, 2, null, 22));
    }

    private static LiveCallState.Action one(List<LiveCallState.Action> actions, LiveCallState.Kind kind) {
        equal(actions.size(), 1);
        equal(actions.get(0).kind, kind);
        return actions.get(0);
    }

    private static void empty(List<LiveCallState.Action> actions) { equal(actions.size(), 0); }
    private static void check(boolean condition) { if (!condition) throw new AssertionError("Condition failed"); }
    private static void equal(Object actual, Object expected) {
        if (!java.util.Objects.equals(actual, expected)) {
            throw new AssertionError("Expected " + expected + ", got " + actual);
        }
    }

    private static void run(String name, Runnable test) {
        try { test.run(); passed++; }
        catch (Throwable failure) { throw new AssertionError(name, failure); }
    }
}
