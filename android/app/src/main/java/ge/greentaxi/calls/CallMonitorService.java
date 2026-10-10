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
import android.os.SystemClock;
import android.provider.CallLog;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.PhoneStateListener;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
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
    // Telephony events must be durably handled without waiting for an in-flight HTTP request.
    private final ExecutorService liveWorker = Executors.newSingleThreadExecutor();
    private LiveCallState liveState = new LiveCallState(Collections.emptySet());
    private final Map<Integer, PhoneStateListener> phoneListeners = new HashMap<>();
    private final Map<Integer, TelephonyManager> phoneManagers = new HashMap<>();
    private Set<Integer> activeSubscriptions = Collections.emptySet();
    private SubscriptionManager subscriptionManager;
    private SubscriptionManager.OnSubscriptionsChangedListener subscriptionListener;
    private int listenerGeneration;
    private volatile String liveDiagnostic = "";
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
                queue.markOpenSessionsGap();
                startLiveMonitoring();
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
        scheduleScan(800);
    }

    private synchronized void scheduleScan(long delayMillis) {
        if (worker.isShutdown()) return;
        if (quickScan != null) quickScan.cancel(false);
        quickScan = worker.schedule(this::tick, delayMillis, TimeUnit.MILLISECONDS);
    }

    @SuppressWarnings("deprecation")
    private void startLiveMonitoring() {
        // Android 11 also provides subscription-scoped mobile-call callbacks. Its public
        // getCallState() includes other ConnectionServices, so it must not be used as a
        // substitute for the state of this SIM. Older releases retain verified log sync.
        if (Build.VERSION.SDK_INT < 30) {
            liveDiagnostic = "ვიყენებთ ზარების ჟურნალს — პასუხისას დამატება ამ Android-ზე მიუწვდომელია. ";
            return;
        }
        subscriptionManager = getSystemService(SubscriptionManager.class);
        if (subscriptionManager == null) {
            liveDiagnostic = "SIM-ის პირდაპირი მონიტორინგი მიუწვდომელია; ვამოწმებთ ზარების ჟურნალს. ";
            return;
        }
        subscriptionListener = new SubscriptionManager.OnSubscriptionsChangedListener() {
            @Override public void onSubscriptionsChanged() { configureSubscriptions(); }
        };
        try {
            subscriptionManager.addOnSubscriptionsChangedListener(subscriptionListener);
            configureSubscriptions();
        } catch (RuntimeException unavailable) {
            liveDiagnostic = "SIM-ის პირდაპირი მონიტორინგი მიუწვდომელია; ვამოწმებთ ზარების ჟურნალს. ";
        }
    }

    @SuppressWarnings("deprecation")
    @android.annotation.TargetApi(30)
    private void configureSubscriptions() {
        if (worker.isShutdown() || !settings.enabled()) return;
        Set<Integer> next = new HashSet<>();
        try {
            List<SubscriptionInfo> subscriptions = subscriptionManager.getActiveSubscriptionInfoList();
            if (subscriptions != null) for (SubscriptionInfo info : subscriptions) {
                if (info.getSubscriptionId() >= 0 && info.getSubscriptionType() == SubscriptionManager.SUBSCRIPTION_TYPE_LOCAL_SIM) {
                    next.add(info.getSubscriptionId());
                }
            }
            if (next.isEmpty()) liveDiagnostic = "აქტიური SIM არ ჩანს; ვამოწმებთ ზარების ჟურნალს. ";
            if (next.equals(activeSubscriptions) && next.equals(phoneListeners.keySet())) return;
            unregisterPhoneListeners();
            activeSubscriptions = Collections.unmodifiableSet(new HashSet<>(next));
            final long wall = System.currentTimeMillis();
            final long elapsed = SystemClock.elapsedRealtime();
            submitLive(() -> {
                applyLiveActions(liveState.setSubscriptions(Collections.emptySet(), wall, elapsed));
                liveState = new LiveCallState(next);
            });
            if (next.isEmpty()) {
                liveDiagnostic = "აქტიური SIM არ ჩანს; ვამოწმებთ ზარების ჟურნალს. ";
                return;
            }
            TelephonyManager telephony = getSystemService(TelephonyManager.class);
            if (telephony == null) throw new IllegalStateException("telephony_unavailable");
            final int generation = listenerGeneration;
            for (int subId : next) {
                TelephonyManager manager = telephony.createForSubscriptionId(subId);
                PhoneStateListener listener = new PhoneStateListener() {
                    @Override public void onCallStateChanged(int state, String number) {
                        // Capture both clocks when the main-looper callback arrives, before worker lag.
                        final long observedWall = System.currentTimeMillis();
                        final long observedElapsed = SystemClock.elapsedRealtime();
                        if (generation != listenerGeneration || !settings.enabled() || !permissionsGranted(CallMonitorService.this)) return;
                        int observedState = state;
                        if (Build.VERSION.SDK_INT >= 31 && state == TelephonyManager.CALL_STATE_OFFHOOK) {
                            try {
                                // Use the actual state for delayed callbacks; never invent IDLE during call waiting.
                                observedState = manager.getCallStateForSubscription();
                            } catch (SecurityException unavailable) { return; }
                            catch (RuntimeException unavailable) { return; }
                        }
                        // On Android 11 the explicit subscription listener is the mobile-only
                        // authority. The same idle-first state machine rejects outgoing calls,
                        // call waiting and observation gaps on both Android versions.
                        final int currentState = observedState;
                        final String phone = CallerPhone.normalize(number);
                        submitLive(() -> applyLiveActions(liveState.onState(subId, currentState, phone, observedWall, observedElapsed)));
                    }
                };
                phoneManagers.put(subId, manager);
                phoneListeners.put(subId, listener);
                manager.listen(listener, PhoneStateListener.LISTEN_CALL_STATE);
            }
            liveDiagnostic = "";
        } catch (SecurityException unavailable) {
            liveSetupUnavailable();
        } catch (RuntimeException unavailable) {
            liveSetupUnavailable();
        }
    }

    private void liveSetupUnavailable() {
        unregisterPhoneListeners();
        liveDiagnostic = "პასუხისას ამოცნობა მიუწვდომელია; ვამოწმებთ ზარების ჟურნალს. ";
        final long wall = System.currentTimeMillis();
        final long elapsed = SystemClock.elapsedRealtime();
        submitLive(() -> applyLiveActions(liveState.setSubscriptions(Collections.emptySet(), wall, elapsed)));
    }

    @SuppressWarnings("deprecation")
    private void unregisterPhoneListeners() {
        listenerGeneration++;
        for (Map.Entry<Integer, PhoneStateListener> entry : phoneListeners.entrySet()) {
            try { phoneManagers.get(entry.getKey()).listen(entry.getValue(), PhoneStateListener.LISTEN_NONE); }
            catch (RuntimeException unavailable) { /* No phone/account data is logged. */ }
        }
        phoneListeners.clear();
        phoneManagers.clear();
    }

    private void submitLive(Runnable task) {
        if (liveWorker.isShutdown()) return;
        try {
            liveWorker.execute(() -> {
                if (!settings.enabled() || liveWorker.isShutdown()) return;
                try { task.run(); }
                catch (RuntimeException unavailable) {
                    liveDiagnostic = "ზარის პირდაპირი შენახვა ვერ შესრულდა; ვამოწმებთ ჟურნალს. ";
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException stopped) { /* Service is stopping. */ }
    }

    private void applyLiveActions(List<LiveCallState.Action> actions) {
        for (LiveCallState.Action action : actions) {
            if (!settings.enabled() || liveWorker.isShutdown()) return;
            queue.liveAction(action, settings.installationId());
            if (action.kind == LiveCallState.Kind.ANSWER) scheduleScan(0);
            else if (action.kind == LiveCallState.Kind.END || action.kind == LiveCallState.Kind.ABANDON) scheduleScan();
        }
    }

    private void tick() {
        if (!settings.enabled() || worker.isShutdown()) return;
        if (!permissionsGranted(this)) {
            setStatus("ზარების წვდომა შეწყდა — შეამოწმეთ ნებართვები");
            stopSelf();
            return;
        }
        try {
            int unresolved = 0;
            String scanDiagnostic = "";
            try { unresolved = scanCalls(); }
            catch (SecurityException unavailable) {
                scanDiagnostic = "ჟურნალი მიუწვდომელია; მიღებული ზარები გაგზავნას ელოდება. ";
            } catch (Exception unavailable) {
                scanDiagnostic = "ჟურნალის შემოწმება დროებით ვერ შესრულდა. ";
            }
            String syncStatus = uploadPending();
            if (unresolved > 0) {
                syncStatus = "ჟურნალთან დაკავშირება მოწმდება (" + unresolved + "). " + syncStatus;
            }
            setStatus(liveDiagnostic + scanDiagnostic + syncStatus);
        } catch (SecurityException unavailable) {
            setStatus("ზარების წვდომა მიუწვდომელია — შეამოწმეთ ნებართვები");
        } catch (Exception failure) {
            setStatus("სინქრონიზაცია დროებით ვერ შესრულდა; ხელახლა ვცდით");
        }
    }

    private int scanCalls() throws Exception {
        // Flush already received telephony transitions before deciding a row has no live session.
        liveWorker.submit(() -> {}).get(5, TimeUnit.SECONDS);
        long baseline = settings.baseline();
        long lastDate = settings.lastDate();
        long lastRow = settings.lastRow();
        long overlapStart = Math.max(baseline, lastDate - OVERLAP_MS);
        String[] projection = {CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
                CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.NUMBER_PRESENTATION,
                CallLog.Calls.PHONE_ACCOUNT_ID, CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME};
        String selection = CallLog.Calls.DATE + " >= ? AND (" + CallLog.Calls._ID + " > ? OR " + CallLog.Calls.DATE + " >= ?)";
        long maxRow = lastRow, maxDate = lastDate;
        long unresolvedRow = Long.MAX_VALUE, unresolvedDate = Long.MAX_VALUE;
        int unresolved = 0;
        List<CallReconciler.Log> rows = new ArrayList<>();
        String installationId = settings.installationId();
        try (Cursor calls = getContentResolver().query(CallLog.Calls.CONTENT_URI, projection, selection,
                new String[]{Long.toString(baseline), Long.toString(lastRow), Long.toString(overlapStart)},
                CallLog.Calls.DATE + " ASC, " + CallLog.Calls._ID + " ASC")) {
            if (calls == null) throw new IllegalStateException("call_provider_unavailable");
            while (calls.moveToNext()) {
                long row = calls.getLong(0), date = calls.getLong(3);
                maxRow = Math.max(maxRow, row);
                maxDate = Math.max(maxDate, date);
                if (calls.getInt(2) != CallLog.Calls.INCOMING_TYPE || date < baseline) continue;
                String oldId = "android:" + installationId + ":" + row + ":" + date;
                // Existing v1/v2 fallback rows and linked live rows cannot create new graph edges.
                if (queue.linked(row, date) || queue.containsEvent(oldId)) continue;
                VerifiedAccount account = simAccount(calls.getString(6), calls.getString(7));
                if (account == null) {
                    unresolved++;
                    unresolvedRow = Math.min(unresolvedRow, row);
                    unresolvedDate = Math.min(unresolvedDate, date);
                    continue;
                }
                if (!account.sim) continue;
                String phone = calls.getInt(5) == CallLog.Calls.PRESENTATION_ALLOWED
                        ? CallerPhone.normalize(calls.getString(1)) : null;
                rows.add(new CallReconciler.Log(row, date, Math.max(0, calls.getLong(4)), account.subId, phone));
            }
        }
        for (CallReconciler.Result result : CallReconciler.reconcile(queue.unlinkedSessions(), rows)) {
            boolean deferred = result.decision == CallReconciler.Decision.DEFER;
            if (result.decision == CallReconciler.Decision.MATCH) {
                deferred = !queue.linkAndComplete(result.row, result.session);
            } else if (result.decision == CallReconciler.Decision.NEW) {
                String id = "android:" + installationId + ":" + result.row.rowId + ":" + result.row.dateWall;
                queue.enqueue(id, result.row.phoneGE9, result.row.dateWall, result.row.durationSeconds);
            }
            if (deferred) {
                unresolved++;
                unresolvedRow = Math.min(unresolvedRow, result.row.rowId);
                unresolvedDate = Math.min(unresolvedDate, result.row.dateWall);
            }
        }
        if (unresolved > 0) {
            maxRow = Math.min(maxRow, Math.max(0, unresolvedRow - 1));
            maxDate = Math.min(maxDate, unresolvedDate);
        }
        settings.watermark(maxRow, maxDate);
        return unresolved;
    }

    private static final class VerifiedAccount {
        final boolean sim;
        final int subId;
        VerifiedAccount(boolean sim, int subId) { this.sim = sim; this.subId = subId; }
    }

    private VerifiedAccount accountInfo(PhoneAccountHandle handle, PhoneAccount account) {
        boolean sim = account.hasCapabilities(PhoneAccount.CAPABILITY_SIM_SUBSCRIPTION);
        int subId = -1;
        if (sim && Build.VERSION.SDK_INT >= 30) {
            try {
                TelephonyManager telephony = getSystemService(TelephonyManager.class);
                if (telephony != null) subId = telephony.getSubscriptionId(handle);
            } catch (SecurityException unavailable) { /* A known SIM may still lack a usable mapping. */ }
            catch (RuntimeException unavailable) { /* Retain conservative log recovery. */ }
        }
        return new VerifiedAccount(sim, subId);
    }

    private VerifiedAccount simAccount(String accountId, String componentName) {
        if (accountId == null || accountId.isEmpty()) return null;
        try {
            TelecomManager telecom = getSystemService(TelecomManager.class);
            if (telecom == null) return null;
            ComponentName component = componentName == null ? null : ComponentName.unflattenFromString(componentName);
            if (component != null) {
                PhoneAccountHandle handle = new PhoneAccountHandle(component, accountId);
                PhoneAccount account = telecom.getPhoneAccount(handle);
                if (account != null) return accountInfo(handle, account);
            }
            for (PhoneAccountHandle handle : telecom.getCallCapablePhoneAccounts()) {
                if (accountId.equals(handle.getId()) && (component == null || component.equals(handle.getComponentName()))) {
                    PhoneAccount account = telecom.getPhoneAccount(handle);
                    if (account != null) return accountInfo(handle, account);
                }
            }
        } catch (SecurityException unavailable) { /* Already verified queued events still upload. */ }
        return null;
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
        for (int pass = 0; pass < 2; pass++) {
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
                if (!event.legacyPayload) payload.put("phase", event.phase);
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
                    queue.delivered(event);
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
        unregisterPhoneListeners();
        if (subscriptionManager != null && subscriptionListener != null) {
            try { subscriptionManager.removeOnSubscriptionsChangedListener(subscriptionListener); }
            catch (RuntimeException unavailable) { /* No account data is logged. */ }
        }
        liveWorker.shutdownNow();
        worker.shutdownNow();
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
        stopForeground(STOP_FOREGROUND_REMOVE);
        // Close SQLite after workers leave their transactions, not underneath an active enqueue.
        new Thread(() -> {
            try {
                if (liveWorker.awaitTermination(5, TimeUnit.SECONDS) && worker.awaitTermination(20, TimeUnit.SECONDS)) {
                    queue.close();
                }
            } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            catch (RuntimeException unavailable) { /* Process restart marks any remaining gap. */ }
        }, "greentaxi-monitor-cleanup").start();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
