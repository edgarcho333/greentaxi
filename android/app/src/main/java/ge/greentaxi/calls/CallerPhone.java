package ge.greentaxi.calls;

/** Matches the server's national Georgian format while retaining valid foreign numbers. */
final class CallerPhone {
    private CallerPhone() {}

    static String normalize(String value) {
        if (value == null) return null;
        String input = value.trim();
        if (input.isEmpty() || !input.matches("^\\+?[0-9\\s()-]+$")) return null;
        String digits = input.replaceAll("[^0-9]", "");
        if (digits.startsWith("00") && digits.length() >= 11) digits = digits.substring(2);
        if (digits.length() == 12 && digits.startsWith("995")) return digits.substring(3);
        if (digits.length() == 9 && !input.startsWith("+")) return digits;
        if (digits.length() < 9 || digits.length() > 15 || digits.startsWith("0")) return null;
        return "+" + digits;
    }
}
