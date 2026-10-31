package ge.greentaxi.calls;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.telecom.Call;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Serial durable capture behind the phone UI. Answering a call never waits for HTTP or SQLite. */
final class TelecomCapture implements AutoCloseable {
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "greentaxi-telecom-capture");
        thread.setDaemon(true);
        return thread;
    });
    private final Context context;
    private final AppSettings settings;
    private final CallQueue queue;
    private boolean closed;

    TelecomCapture(Context context) {
        this.context = context.getApplicationContext();
        settings = new AppSettings(this.context);
        queue = new CallQueue(this.context);
    }

    void observe(Call call) { snapshot(call, false); }
    void removed(Call call) { snapshot(call, true); }

    private void snapshot(Call call, boolean removed) {
        if (closed || Build.VERSION.SDK_INT < 35 || !settings.enabled() || !settings.hasToken()) return;
        try {
            TelecomManager telecom = context.getSystemService(TelecomManager.class);
            if (telecom == null || !context.getPackageName().equals(telecom.getDefaultDialerPackage())) return;
            Call.Details details = call.getDetails();
            if (details == null || details.getCallDirection() != Call.Details.DIRECTION_INCOMING
                    || details.hasProperty(Call.Details.PROPERTY_SELF_MANAGED)
                    || details.hasProperty(Call.Details.PROPERTY_IS_EXTERNAL_CALL)
                    || details.hasProperty(Call.Details.PROPERTY_CONFERENCE)) return;
            PhoneAccountHandle handle = details.getAccountHandle();
            if (handle == null || handle.getComponentName() == null) return;
            PhoneAccount account = telecom.getPhoneAccount(handle);
            if (account == null || !account.hasCapabilities(PhoneAccount.CAPABILITY_SIM_SUBSCRIPTION)) return;
            TelephonyManager telephony = context.getSystemService(TelephonyManager.class);
            if (telephony == null) return;
            int subId = telephony.getSubscriptionId(handle);
            if (subId < 0 || details.getId() == null || details.getId().isEmpty() || details.getCreationTimeMillis() <= 0) return;
            Uri uri = details.getHandle();
            String phone = details.getHandlePresentation() == TelecomManager.PRESENTATION_ALLOWED
                    && uri != null && "tel".equalsIgnoreCase(uri.getScheme())
                    ? CallerPhone.normalize(uri.getSchemeSpecificPart()) : null;
            int state = details.getState();
            TelecomSnapshot.State evidence = removed || state == Call.STATE_DISCONNECTED
                    ? TelecomSnapshot.State.ENDED : state == Call.STATE_ACTIVE ? TelecomSnapshot.State.ACTIVE
                    : state == Call.STATE_HOLDING ? TelecomSnapshot.State.HOLDING
                    : state == Call.STATE_RINGING ? TelecomSnapshot.State.RINGING : TelecomSnapshot.State.OTHER;
            DisconnectCause cause = details.getDisconnectCause();
            if (evidence == TelecomSnapshot.State.ENDED && details.getConnectTimeMillis() <= 0 && cause != null
                    && (cause.getCode() == DisconnectCause.MISSED || cause.getCode() == DisconnectCause.REJECTED)) {
                evidence = TelecomSnapshot.State.UNANSWERED;
            }
            String accountId = handle.getComponentName().flattenToString() + ":" + handle.getId() + ":" + handle.getUserHandle();
            TelecomSnapshot snapshot = new TelecomSnapshot(details.getId(), accountId, subId, phone,
                    details.getCreationTimeMillis(), details.getConnectTimeMillis(), System.currentTimeMillis(),
                    SystemClock.elapsedRealtime(), evidence);
            long baseline = settings.baseline();
            WORKER.execute(() -> {
                try {
                    if (queue.telecomObservation(snapshot, settings.installationId(), baseline)) {
                        CallMonitorService.nudge(context);
                    }
                } catch (RuntimeException failure) {
                    // Do not log caller numbers, account identifiers, or exception messages.
                    settings.deliveryFailure("storage");
                }
            });
        } catch (SecurityException denied) {
            settings.deliveryFailure("permission");
        } catch (RuntimeException unavailable) {
            // The phone UI remains usable even if the OEM briefly withholds call details.
            settings.deliveryFailure("unknown");
        }
    }

    /** A scanner must not classify a final journal row before already received Call callbacks commit. */
    static boolean awaitPending(long timeoutMillis) {
        try {
            WORKER.submit(() -> {}).get(Math.max(1, timeoutMillis), TimeUnit.MILLISECONDS);
            return true;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return false;
        } catch (TimeoutException | java.util.concurrent.ExecutionException unavailable) {
            return false;
        }
    }

    @Override public void close() {
        if (closed) return;
        closed = true;
        WORKER.execute(queue::close);
    }
}
