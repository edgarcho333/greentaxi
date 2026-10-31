package ge.greentaxi.calls;

public final class DeliveryPolicyTest {
    public static void main(String[] args) {
        long[] delays = {3_000L, 10_000L, 30_000L, 60_000L, 120_000L};
        for (int index = 0; index < delays.length; index++) {
            require(DeliveryPolicy.retryDelayMillis(index + 1) == delays[index], "rapid retry sequence");
        }
        require(DeliveryPolicy.retryDelayMillis(Integer.MIN_VALUE) == 3_000L, "invalid attempt bounded");
        require(DeliveryPolicy.retryDelayMillis(Integer.MAX_VALUE) == 120_000L, "retry cap cannot overflow");
        require(DeliveryPolicy.retryDelayMillis(30) == 120_000L, "upgraded old high attempt has short cap");

        int streak = 0, normalSelections = 0;
        for (int request = 1; request <= 100; request++) {
            boolean urgent = DeliveryPolicy.preferUrgent(streak);
            if (!urgent) {
                normalSelections++;
                require(request % 5 == 0, "continuous urgent arrivals cannot starve older calls");
            }
            streak = DeliveryPolicy.afterSelection(streak, urgent);
        }
        require(normalSelections == 20, "one fifth of selections always services backlog");
        require(DeliveryPolicy.afterSelection(3, false) == 0, "ordinary event restores urgent allowance");
        require(DeliveryPolicy.afterSelection(Integer.MAX_VALUE, true) == 4, "streak bounded");

        require(DeliveryPolicy.safeErrorCode(null).equals(""), "null error empty");
        require(DeliveryPolicy.safeErrorCode("http_503").equals("http_503"), "known HTTP error kept");
        require(DeliveryPolicy.safeErrorCode("connection_failed").equals("connection_failed"), "network error kept");
        require(DeliveryPolicy.safeErrorCode("https://private.invalid/?token=secret").equals("connection_failed"), "arbitrary exception cannot leak through telemetry");
        require(DeliveryPolicy.safeErrorCode("http_999").equals("connection_failed"), "invalid HTTP error rejected");
        System.out.println("DeliveryPolicyTest passed (retry bounds, bounded urgency, safe errors)");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
