package ge.greentaxi.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.CallLog;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public final class CallMonitorService extends Service {
    private static final String CHANNEL = "greentaxi_call_monitor";
    private static final int NOTIFICATION_ID = 10;
    private static final long OVERLAP_MS = 24 * 60 * 60_000L;
    private static volatile boolean running;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private AppSettings settings;
    private CallQueue queue;
    private ContentObserver observer;
    private boolean started;
    private ScheduledFuture<?> quickScan;
    private volatile HttpURLConnection connection;

    @Override public void onCreate() {
        super.onCreate();
        settings = new AppSettings(this);
        queue = new CallQueue(this);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "ზარების მონიტორინგი", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("მიღებული შემომავალი ზარების სინქრონიზაცია");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    static boolean permissionsGranted(android.content.Context context) {
        return context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean isRunning() { return running; }

    static boolean notificationsEnabled(android.content.Context context) {
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!settings.enabled() || !settings.hasToken() || settings.server().isEmpty()) {
            running = false;
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!permissionsGranted(this)) {
            running = false;
            settings.status("ზარების წვდომა აკლია — გახსენით აპი და შეამოწმეთ ნებართვები");
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            Notification notification = notification("მონიტორინგი ჩართულია");
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            if (!started) {
                ContentObserver newObserver = new ContentObserver(mainHandler) {
                    @Override public void onChange(boolean selfChange) { scheduleScan(); }
                };
                getContentResolver().registerContentObserver(CallLog.Calls.CONTENT_URI, true, newObserver);
                observer = newObserver;
                worker.scheduleWithFixedDelay(this::tick, 0, 60, TimeUnit.SECONDS);
                started = true;
            } else {
                scheduleScan();
            }
            running = true;
        } catch (RuntimeException unavailable) {
            running = false;
            settings.status("მონიტორინგი ვერ ჩაირთო — შეამოწმეთ აპის ნებართვები და პარამეტრები");
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private synchronized void scheduleScan() {
        if (worker.isShutdown()) return;
        if (quickScan != null) quickScan.cancel(false);
        quickScan = worker.schedule(this::tick, 800, TimeUnit.MILLISECONDS);
    }

    private void tick() {
        if (!settings.enabled() || worker.isShutdown()) return;
        if (!permissionsGranted(this)) {
            setStatus("ზარების წვდომა შეწყდა — შეამოწმეთ ნებართვები");
            stopSelf();
            return;
        }
        try {
            int unresolved = scanCalls();
            String syncStatus = uploadPending();
            if (unresolved > 0) {
                syncStatus = "SIM-ის ამოცნობა ვერ მოხერხდა (" + unresolved + "). " + syncStatus;
            }
            setStatus(syncStatus);
        } catch (SecurityException unavailable) {
            setStatus("ზარების წვდომა მიუწვდომელია — შეამოწმეთ ნებართვები");
        } catch (Exception failure) {
            setStatus("სინქრონიზაცია დროებით ვერ შესრულდა; ხელახლა ვცდით");
        }
    }

    private int scanCalls() {
        long baseline = settings.baseline();
        long lastDate = settings.lastDate();
        long lastRow = settings.lastRow();
        long overlapStart = Math.max(baseline, lastDate - OVERLAP_MS);
        String[] projection = {CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
                CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.NUMBER_PRESENTATION,
                CallLog.Calls.PHONE_ACCOUNT_ID, CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME};
        String selection = CallLog.Calls.DATE + " >= ? AND (" + CallLog.Calls._ID + " > ? OR " + CallLog.Calls.DATE + " >= ?)";
        long maxRow = lastRow;
        long maxDate = lastDate;
        long unresolvedRow = Long.MAX_VALUE;
        long unresolvedDate = Long.MAX_VALUE;
        int unresolved = 0;
        try (Cursor calls = getContentResolver().query(CallLog.Calls.CONTENT_URI, projection, selection,
                new String[]{Long.toString(baseline), Long.toString(lastRow), Long.toString(overlapStart)},
                CallLog.Calls.DATE + " ASC, " + CallLog.Calls._ID + " ASC")) {
            if (calls == null) throw new IllegalStateException("call_provider_unavailable");
            while (calls.moveToNext()) {
                long row = calls.getLong(0);
                long date = calls.getLong(3);
                maxRow = Math.max(maxRow, row);
                maxDate = Math.max(maxDate, date);
                // INCOMING_TYPE is the answered incoming category, including zero-second calls.
                if (calls.getInt(2) != CallLog.Calls.INCOMING_TYPE || date < baseline) continue;
                int sim = simAccount(calls.getString(6), calls.getString(7));
                if (sim < 0) {
                    unresolved++;
                    unresolvedRow = Math.min(unresolvedRow, row);
                    unresolvedDate = Math.min(unresolvedDate, date);
                    continue;
                }
                if (sim == 0) continue;
                String phone = calls.getInt(5) == CallLog.Calls.PRESENTATION_ALLOWED ? calls.getString(1) : null;
                if (phone != null) {
                    phone = phone.trim();
                    if (phone.isEmpty() || phone.equals("-1") || phone.equals("-2") || phone.equals("-3")) phone = null;
                }
                String eventId = "android:" + settings.installationId() + ":" + row + ":" + date;
                queue.enqueue(eventId, phone, date, calls.getLong(4));
            }
        }
        // Unresolved SIM rows remain eligible for subsequent scans instead of being silently discarded.
        if (unresolved > 0) {
            maxRow = Math.min(maxRow, Math.max(0, unresolvedRow - 1));
            maxDate = Math.min(maxDate, unresolvedDate);
        }
        settings.watermark(maxRow, maxDate);
        return unresolved;
    }

    private int simAccount(String accountId, String componentName) {
        if (accountId == null || accountId.isEmpty()) return -1;
        try {
            TelecomManager telecom = getSystemService(TelecomManager.class);
            if (telecom == null) return -1;
            ComponentName component = componentName == null ? null : ComponentName.unflattenFromString(componentName);
            if (component != null) {
                PhoneAccount account = telecom.getPhoneAccount(new PhoneAccountHandle(component, accountId));
                if (account != null) return account.hasCapabilities(PhoneAccount.CAPABILITY_SIM_SUBSCRIPTION) ? 1 : 0;
            }
            List<PhoneAccountHandle> handles = telecom.getCallCapablePhoneAccounts();
            for (PhoneAccountHandle handle : handles) {
                if (accountId.equals(handle.getId()) && (component == null || component.equals(handle.getComponentName()))) {
                    PhoneAccount account = telecom.getPhoneAccount(handle);
                    if (account != null) return account.hasCapabilities(PhoneAccount.CAPABILITY_SIM_SUBSCRIPTION) ? 1 : 0;
                }
            }
        } catch (SecurityException accountUnavailable) {
            // OEM/account-level denial must not prevent already verified queued calls from uploading.
            return -1;
        }
        return -1;
    }

    private String uploadPending() {
        if (settings.authPaused()) return "კავშირი შეჩერებულია — ხელახლა დააკავშირეთ ტელეფონი";
        if (queue.pendingCount() == 0) return "მონიტორინგი ჩართულია · რიგი ცარიელია; ველოდებით ახალ ზარს";
        ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        NetworkCapabilities network = connectivity == null ? null : connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        if (network == null || !network.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            return "ინტერნეტს ელოდება · ზარები შენახულია ტელეფონში";
        }
        AppSettings.Binding binding = settings.binding();
        String token;
        try {
            token = binding.token();
        } catch (Exception missingKey) {
            if (!settings.pauseAuthenticationIfCurrent(binding)) return "კავშირის მონაცემები შეიცვალა; ზარები გაგზავნას ელოდება";
            return "დაკავშირების კოდი მიუწვდომელია — ხელახლა დააკავშირეთ ტელეფონი";
        }
        String status = "შენახული ზარები გაგზავნას ელოდება; ხელახლა ვცდით";
        for (CallQueue.Event event : queue.due(System.currentTimeMillis())) {
            if (!settings.enabled() || worker.isShutdown()) break;
            if (!settings.bindingCurrent(binding)) return "კავშირის მონაცემები შეიცვალა; ზარები გაგზავნას ელოდება";
            try {
                URL endpoint = new URL(binding.server + "/api/integrations/android/calls");
                if (!"https".equalsIgnoreCase(endpoint.getProtocol())) throw new IllegalStateException("https_required");
                connection = (HttpURLConnection) endpoint.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(15_000);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setRequestProperty("Accept", "application/json");
                connection.setDoOutput(true);
                JSONObject payload = new JSONObject();
                payload.put("eventId", event.id);
                payload.put("phone", event.phone == null ? JSONObject.NULL : event.phone);
                payload.put("occurredAt", Instant.ofEpochMilli(event.occurredAt).toString());
                payload.put("durationSeconds", event.duration);
                payload.put("kind", "incoming");
                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
                int responseCode = connection.getResponseCode();
                if (responseCode == 401) {
                    if (!settings.pauseAuthenticationIfCurrent(binding)) return "კავშირის მონაცემები შეიცვალა; ზარები გაგზავნას ელოდება";
                    return "კავშირი გაუქმებულია — ხელახლა დააკავშირეთ ტელეფონი";
                }
                if (responseCode >= 200 && responseCode < 300) {
                    JSONObject response = new JSONObject(readLimited(connection.getInputStream()));
                    if (response.optString("id", "").isEmpty()) throw new IllegalStateException("response_invalid");
                    queue.delivered(event.id);
                } else {
                    queue.retry(event, "http_" + responseCode);
                    status = "სერვერი მიუწვდომელია (" + responseCode + ") · ზარები შენახულია";
                }
            } catch (Exception transientFailure) {
                queue.retry(event, "connection_failed");
                status = "კავშირი ვერ შესრულდა · ზარები შენახულია; ხელახლა ვცდით";
            } finally {
                HttpURLConnection active = connection;
                connection = null;
                if (active != null) active.disconnect();
            }
        }
        if (queue.pendingCount() == 0) return "მონიტორინგი ჩართულია · რიგი ცარიელია; ველოდებით ახალ ზარს";
        return status;
    }

    private static String readLimited(InputStream source) throws Exception {
        try (InputStream input = source; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 65_536) throw new IllegalStateException("response_too_large");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void setStatus(String status) {
        if (!settings.enabled() || worker.isShutdown()) return;
        settings.status(status);
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(status));
    }

    private Notification notification(String status) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_taxi)
                .setContentTitle("Green Taxi · ზარების მონიტორინგი")
                .setContentText(status).setContentIntent(pending).setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE).build();
    }

    @Override public void onDestroy() {
        running = false;
        if (observer != null) getContentResolver().unregisterContentObserver(observer);
        worker.shutdownNow();
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
        stopForeground(STOP_FOREGROUND_REMOVE);
        queue.close();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
