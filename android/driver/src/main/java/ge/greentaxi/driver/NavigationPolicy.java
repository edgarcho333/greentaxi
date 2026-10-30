package ge.greentaxi.driver;

import java.net.URI;
import java.net.URISyntaxException;

/** Kept independent of Android so navigation boundaries are tested on the JVM. */
public final class NavigationPolicy {
    public static final String DRIVER_URL = "https://green-taxi.ge/driver";

    private NavigationPolicy() {}

    public static boolean isTrustedResource(String value) {
        URI uri = parse(value);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
            && "green-taxi.ge".equalsIgnoreCase(uri.getHost())
            && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static boolean isDriverPage(String value) {
        if (!isTrustedResource(value)) return false;
        String path = parse(value).getRawPath();
        return "/driver".equals(path) || "/driver/".equals(path);
    }

    public static boolean isExternalWebPage(String value) {
        URI uri = parse(value);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
            && uri.getHost() != null && !uri.getHost().isEmpty()
            && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static String dialNumber(String value) {
        URI uri = parse(value);
        if (uri == null || !"tel".equalsIgnoreCase(uri.getScheme()) || uri.getRawFragment() != null) return null;
        String number = uri.getSchemeSpecificPart();
        // No USSD, service codes, pauses, extensions or arbitrary intent payloads.
        return number != null && number.matches("\\+?[0-9]{7,15}") ? number : null;
    }

    private static URI parse(String value) {
        if (value == null || value.indexOf('\\') >= 0 || value.matches("(?s).*[\\p{Cntrl}].*")) return null;
        try { return new URI(value); }
        catch (URISyntaxException ignored) { return null; }
    }
}
