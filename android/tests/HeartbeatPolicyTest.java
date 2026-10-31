package ge.greentaxi.calls;

public final class HeartbeatPolicyTest {
    public static void main(String[] args) {
        firstRequestAndBursts();
        requestsDuringAnAttempt();
        periodicStatusCanBeBroughtForward();
        failureDoesNotMakeAHotLoop();
        wakingAfterSleepDoesNotCatchUpInABurst();
        elapsedClockRollbackIsConservative();
        cancellingPreservesTheRateLimit();
        extremesCannotOverflowIntoAnImmediateLoop();
        invalidTimesAreRejected();
        System.out.println("HeartbeatPolicyTest passed (coalescing, 15-second bound, sleep, failure, clock guards)");
    }

    private static void firstRequestAndBursts() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        equal(policy.nextAt(), -1, "initially idle");
        equal(policy.request(0, 2_000), 2_000, "initial status may wait for startup");
        require(!policy.begin(499), "not before its deadline");
        equal(policy.request(500, 0), 500, "network recovery brings first status forward");
        require(policy.begin(500), "first due status starts");
        equal(policy.nextAt(), -1, "start consumes its request");
        for (long now = 501; now < 2_000; now++) {
            equal(policy.request(now, 0), 15_500, "many call acknowledgments coalesce");
        }
        require(!policy.begin(15_499), "bursts cannot bypass the minimum interval");
        require(policy.begin(15_500), "one coalesced status is due after 15 seconds");
        require(!policy.begin(15_500), "one request cannot start twice");
    }

    private static void requestsDuringAnAttempt() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        policy.request(1_000, 0);
        require(policy.begin(1_000), "an HTTP attempt begins");
        equal(policy.request(2_000, 0), 16_000, "an enqueue during HTTP retains a follow-up");
        equal(policy.request(5_000, 0), 16_000, "an ACK during HTTP shares that follow-up");
        require(policy.begin(20_000), "a slow request can be followed once the minimum has passed");
        equal(policy.request(20_001, 0), 35_000, "subsequent status uses the actual new start");
    }

    private static void periodicStatusCanBeBroughtForward() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        equal(policy.request(0, 60_000), 60_000, "periodic idle status scheduled");
        equal(policy.request(10_000, 0), 10_000, "new call sends status before periodic deadline");
        require(policy.begin(10_000), "event status starts");
        equal(policy.request(10_001, 60_000), 70_001, "next periodic request keeps its delay");
        equal(policy.request(20_000, 0), 25_000, "delivery ACK advances it only to rate-limit floor");
        equal(policy.request(21_000, 60_000), 25_000, "later periodic request cannot postpone useful status");
    }

    private static void failureDoesNotMakeAHotLoop() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        policy.request(0, 0);
        require(policy.begin(0), "failing attempt starts");
        for (long now = 1; now < 15_000; now += 97) {
            policy.request(now, 0);
            require(!policy.begin(now), "HTTP failure plus repeated requests cannot flood server");
        }
        require(policy.begin(15_000), "next attempted request remains bounded");
    }

    private static void wakingAfterSleepDoesNotCatchUpInABurst() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        policy.request(0, 0);
        require(policy.begin(0), "first status");
        policy.request(1, 60_000);
        require(policy.begin(600_000), "an overdue status is sent when the process resumes");
        equal(policy.request(600_000, 0), 615_000, "missed periods do not allow back-to-back attempts");
        require(!policy.begin(600_000), "no catch-up flood");
    }

    private static void elapsedClockRollbackIsConservative() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        policy.request(20_000, 0);
        require(policy.begin(20_000), "initial attempt");
        equal(policy.request(20_001, 0), 35_000, "next rate-limit deadline");
        equal(policy.request(5_000, 0), 20_000, "rollback waits a fresh complete interval");
        require(!policy.begin(19_999), "rollback cannot cause immediate retry");
        require(policy.begin(20_000), "status resumes conservatively");
    }

    private static void cancellingPreservesTheRateLimit() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        policy.request(0, 0);
        require(policy.begin(0), "initial status");
        policy.request(1, 0);
        policy.clear();
        equal(policy.nextAt(), -1, "pending status is canceled");
        equal(policy.request(2, 0), 15_000, "canceling does not reset the attempt history");
    }

    private static void extremesCannotOverflowIntoAnImmediateLoop() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        equal(policy.request(Long.MAX_VALUE - 5, 10), Long.MAX_VALUE, "large delay saturates safely");
        require(!policy.begin(Long.MAX_VALUE - 1), "saturated deadline does not run early");
        require(policy.begin(Long.MAX_VALUE), "one saturated deadline can run");
        equal(policy.request(Long.MAX_VALUE, 0), -1, "no representable future interval means no repeat loop");
        require(!policy.begin(Long.MAX_VALUE), "saturated clock cannot send repeatedly");
    }

    private static void invalidTimesAreRejected() {
        HeartbeatPolicy policy = new HeartbeatPolicy();
        illegal(() -> policy.request(-1, 0));
        illegal(() -> policy.request(0, -1));
        illegal(() -> policy.begin(-1));
    }

    private static void illegal(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("invalid elapsed timestamp or delay accepted");
    }

    private static void equal(long actual, long expected, String reason) {
        if (actual != expected) throw new AssertionError(reason + ": " + actual + " != " + expected);
    }

    private static void require(boolean condition, String reason) {
        if (!condition) throw new AssertionError(reason);
    }
}
