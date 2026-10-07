package ge.greentaxi.calls;

public final class CallerPhoneTest {
    public static void main(String[] args) {
        check("599123456", "599123456");
        check("+995 599 12 34 56", "599123456");
        check("995599123456", "599123456");
        check("00995599123456", "599123456");
        check("599-12-34-56", "599123456");
        check("+442071234567", "+442071234567");
        check("00442071234567", "+442071234567");
        check("442071234567", "+442071234567");
        check("+123456789", "+123456789");
        check(null, null);
        check("", null);
        check("-1", null);
        check("Private", null);
        check("+995599123456;123", null);
        check("599123456abc", null);
        check("++995599123456", null);
        check("000000000000", null);
        check("123", null);
        check("1234567890123456", null);
        System.out.println("CallerPhoneTest passed (19 cases)");
    }

    private static void check(String input, String expected) {
        String result = CallerPhone.normalize(input);
        if (expected == null ? result != null : !expected.equals(result)) throw new AssertionError("phone normalization");
    }
}
