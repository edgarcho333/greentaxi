package ge.greentaxi.driver;

/** Security boundaries: trusted login stays inside, telephone links cannot run USSD. */
public final class NavigationPolicyTest {
    public static void main(String[] args) {
        for (String url : new String[] {
            "https://green-taxi.ge/driver", "https://green-taxi.ge/driver/", "https://green-taxi.ge:443/driver?day=tomorrow#orders"
        }) check(NavigationPolicy.isDriverPage(url), "Trusted driver route rejected");
        for (String url : new String[] {
            "http://green-taxi.ge/driver", "https://green-taxi.ge.evil.test/driver", "https://green-taxi.ge@evil.test/driver",
            "https://evil.test@green-taxi.ge/driver", "https://green-taxi.ge:444/driver", "https://green-taxi.ge/admin",
            "https://green-taxi.ge/driver/other", "https://green-taxi.ge/%2fadmin", "https://green-taxi.ge/%64river", "javascript:alert(1)",
            "file:///driver", "content://driver", "intent://driver", "https://green-taxi.ge\\@evil.test/driver",
            "https://green-taxi.ge/driver\n", "data:text/html,driver", null
        }) check(!NavigationPolicy.isDriverPage(url), "Unsafe page accepted");
        check(NavigationPolicy.isTrustedResource("https://green-taxi.ge/api/driver/auth/session"), "API rejected");
        check(NavigationPolicy.isTrustedResource("https://green-taxi.ge/assets/index.js"), "Asset rejected");
        check(!NavigationPolicy.isTrustedResource("https://evil.test/asset.js"), "Foreign resource accepted");
        check(NavigationPolicy.isExternalWebPage("https://green-taxi.ge/"), "Website browser link rejected");
        check(!NavigationPolicy.isExternalWebPage("javascript:alert(1)"), "Script accepted as browser link");
        check("+995599123456".equals(NavigationPolicy.dialNumber("tel:+995599123456")), "Georgian phone rejected");
        for (String value : new String[] { "tel:*100%23", "tel:555123456;123", "tel:555123456?x=1", "tel:555123456#x", "intent:tel:555123456", "tel:abc", "tel:+123", "tel:+1234567890123456" }) {
            check(NavigationPolicy.dialNumber(value) == null, "Unsafe telephone target accepted");
        }
        System.out.println("Driver navigation policy checks passed.");
    }
    private static void check(boolean result, String message) { if (!result) throw new AssertionError(message); }
}
