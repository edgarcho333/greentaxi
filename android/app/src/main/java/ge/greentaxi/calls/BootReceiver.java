package ge.greentaxi.calls;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        AppSettings settings = new AppSettings(context);
        if (!settings.enabled() || !settings.hasToken() || !CallMonitorService.permissionsGranted(context)) return;
        try {
            context.startForegroundService(new Intent(context, CallMonitorService.class));
        } catch (RuntimeException restricted) {
            settings.status("გახსენით აპი მონიტორინგის გასაგრძელებლად");
        }
    }
}
