package ge.greentaxi.calls;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.telecom.TelecomManager;

/** The pilot never changes the phone application without Android's role chooser. */
final class DialerRole {
    private DialerRole() {}

    static boolean isDefault(Context context) {
        if (!BuildConfig.PHONE_PILOT) return false;
        try {
            TelecomManager telecom = context.getSystemService(TelecomManager.class);
            return telecom != null && context.getPackageName().equals(telecom.getDefaultDialerPackage());
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    static void request(Activity activity, int requestCode) {
        if (!BuildConfig.PHONE_PILOT) return;
        if (Build.VERSION.SDK_INT >= 29) {
            RoleManager roles = activity.getSystemService(RoleManager.class);
            if (roles != null && roles.isRoleAvailable(RoleManager.ROLE_DIALER)) {
                activity.startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_DIALER), requestCode);
                return;
            }
        }
        Intent choose = new Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER)
                .putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, activity.getPackageName());
        activity.startActivityForResult(choose, requestCode);
    }

    static void openDefaultSettings(Activity activity) {
        // Android's own selector lists the installed Samsung phone application.
        activity.startActivity(new Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS));
    }
}
