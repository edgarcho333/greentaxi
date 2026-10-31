package ge.greentaxi.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Network;
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
    // Journal reconciliation must not wait behind a slow HTTP request.
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService uploadWorker = Executors.newSingleThreadScheduledExecutor();
    // Status requests have their own bounded connection and never occupy the call uploader.
    private final ScheduledExecutorService heartbeatWorker = Executors.newSingleThreadScheduledExecutor();
    private final Object heartbeatLock = new Object();
    private final HeartbeatPolicy heartbeatPolicy = new HeartbeatPolicy();
    private ScheduledFuture<?> pendingHeartbeat;
    private long heartbeatGeneration;
    private long scheduledHeartbeatElapsed = Long.MAX_VALUE;
    private boolean heartbeating;
    private final Object uploadLock = new Object();
    private ScheduledFuture<?> pendingUpload;
    private long uploadGeneration;
    private long scheduledUploadElapsed = Long.MAX_VALUE;
    private long requestedUploadElapsed = Long.MAX_VALUE;
    private long uploadNotBeforeElapsed;
    private boolean uploading;
    private volatile boolean stopping;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Network validatedNetwork;
    private volatile String journalDiagnostic = "";
    private volatile String uploadDiagnostic = "მონიტორინგი ჩართულია";
    // Telephony events must be durably handled without waiting for an in-flight HTTP request.
    private final ExecutorService liveWorker = Executors.newSingleThreadExecutor();
    private LiveCallState liveState = new LiveCallState(Collections.emptySet(), true);
    private volatile long allIncomingBaseline = Long.MAX_VALUE;
    private final Map<Integer, PhoneStateListener> phoneListeners = new HashMap<>();
    private final Map<Integer, TelephonyManager> phoneManagers = new HashMap<>();
    private Set<Integer> activeSubscriptions = Collections.emptySet();
    private SubscriptionManager subscriptionManager;
    private SubscriptionManager.OnSubscriptionsChangedListener subscriptionListener;
    private int listenerGeneration;
    private boolean telecomSource;
    private volatile String liveDiagnostic = "";
    private AppSettings settings;
    private CallQueue queue;
    private ContentObserver observer;
    private BroadcastReceiver dialerRoleReceiver;
    private boolean started;
    private ScheduledFuture<?> quickScan;
    private volatile HttpURLConnection connection;
    private volatile HttpURLConnection heartbeatConnection;

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

    /** Wake delivery after a Telecom observation has reached durable storage. */
    static void nudge(android.content.Context context) {
        android.content.Context app = context.getApplicationContext();
        AppSettings saved = new AppSettings(app);
        if (!saved.enabled() || !saved.hasToken() || saved.server().isEmpty() || !permissionsGranted(app)) return;
        try {
            // No baseline, authentication or queue changes: an already enabled
            // monitor may be restarted, but the phone UI never opts it in.
            app.startForegroundService(new Intent(app, CallMonitorService.class));
        } catch (RuntimeException restricted) {
            // Android can refuse a background start. The accepted call remains
            // durable; an existing monitor, network recovery or opening the app retries it.
        }
    }

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
            running = true;
            if (!started) {
                // Enabling the expanded policy must not import previously ignored missed calls.
                allIncomingBaseline = settings.allIncomingBaseline();
                ContentObserver newObserver = new ContentObserver(mainHandler) {
                    @Override public void onChange(boolean selfChange) { scheduleScan(); }
                };
                getContentResolver().registerContentObserver(CallLog.Calls.CONTENT_URI, true, newObserver);
                observer = newObserver;
                queue.markOpenSessionsGap();
                startLiveMonitoring();
                watchDialerRole();
                started = true;
                // Reset persisted pre-update deadlines off the main looper,
                // including on firmware that refuses network callbacks.
                networkRecovered();
                watchNetwork();
                worker.scheduleWithFixedDelay(this::tick, 0, 60, TimeUnit.SECONDS);
                heartbeatWorker.scheduleWithFixedDelay(() -> requestHeartbeat(0), 2, 60, TimeUnit.SECONDS);
                scheduleUpload(0);
            } else {
                configureSubscriptions();
                scheduleScan();
                scheduleUpload(0);
                requestHeartbeat(0);
            }
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

    private void watchDialerRole() {
        if (!BuildConfig.PHONE_PILOT || dialerRoleReceiver != null) return;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                // Read Android's actual role, never a sender-provided package or state.
                configureSubscriptions();
                scheduleScan();
                scheduleUpload(0);
            }
        };
        try {
            IntentFilter filter = new IntentFilter(TelecomManager.ACTION_DEFAULT_DIALER_CHANGED);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            else registerReceiver(receiver, filter);
            dialerRoleReceiver = receiver;
        } catch (RuntimeException unavailable) {
            // Resume/start and periodic refresh still recover if OEM firmware refuses this observer.
        }
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
        if (DialerRole.isDefault(this)) {
            if (!telecomSource || !phoneListeners.isEmpty()) {
                unregisterPhoneListeners();
                activeSubscriptions = Collections.emptySet();
                final long wall = System.currentTimeMillis();
                final long elapsed = SystemClock.elapsedRealtime();
                // Retire aggregate observations when Android hands calls to our
                // InCallService. Previously accepted events keep their identities.
                submitLive(() -> applyLiveActions(liveState.setSubscriptions(Collections.emptySet(), wall, elapsed)));
            }
            telecomSource = true;
            liveDiagnostic = "ტელეფონის რეჟიმი — თითოეული მიღებული ხაზი ცალკე მუშავდება. ";
            return;
        }
        telecomSource = false;
        if (subscriptionManager == null) return;
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
                liveState = new LiveCallState(next, true);
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
                        if (generation != listenerGeneration || !settings.enabled() || !permissionsGranted(CallMonitorService.this)
                                || DialerRole.isDefault(CallMonitorService.this)) return;
                        // This subscription-scoped callback is an observed transition, not
                        // a request for a newer snapshot. Re-reading the current state here
                        // can replace A's answer with B's later waiting/ringing state.
                        // Preserve the ordered callback history on every supported Android.
                        // The conservative state machine still rejects ambiguous waiting,
                        // outgoing calls, registration snapshots and observation gaps.
                        final int currentState = state;
                        final String phone = CallerPhone.normalize(number);
                        submitLive(() -> {
                            // Role selection can happen while this task is queued.
                            if (!DialerRole.isDefault(CallMonitorService.this)) {
                                applyLiveActions(liveState.onState(subId, currentState, phone, observedWall, observedElapsed));
                            }
                        });
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
            if (action.kind == LiveCallState.Kind.ANSWER || action.kind == LiveCallState.Kind.RING) {
                scheduleUpload(0);
                requestHeartbeat(0);
            }
            else if (action.kind == LiveCallState.Kind.END || action.kind == LiveCallState.Kind.ABANDON) scheduleScan();
        }
    }

    private void tick() {
        if (!settings.enabled() || stopping || worker.isShutdown()) return;
        // A role may also change in Android settings while our setup screen is closed.
        mainHandler.post(() -> {
            if (started && !stopping) configureSubscriptions();
        });
        if (!permissionsGranted(this)) {
            settings.deliveryFailure("permission");
            setStatus("ზარების წვდომა შეწყდა — შეამოწმეთ ნებართვები");
            stopSelf();
            return;
        }
        try {
            int unresolved = 0;
            String diagnostic = "";
            try { unresolved = scanCalls(); }
            catch (SecurityException unavailable) {
                diagnostic = "ჟურნალი მიუწვდომელია; მიღებული ზარები გაგზავნას ელოდება. ";
            } catch (Exception unavailable) {
                diagnostic = "ჟურნალის შემოწმება დროებით ვერ შესრულდა. ";
            }
            if (unresolved > 0) diagnostic += "ჟურნალთან დაკავშირება მოწმდება (" + unresolved + "). ";
            journalDiagnostic = diagnostic;
            scheduleUpload(0);
            requestHeartbeat(0);
            refreshDeliveryStatus();
        } catch (RuntimeException unavailable) {
            settings.deliveryFailure("storage");
            setStatus("სინქრონიზაცია დროებით ვერ შესრულდა; ხელახლა ვცდით");
        }
    }

    private void refreshDeliveryStatus() {
        setStatus(liveDiagnostic + journalDiagnostic + uploadDiagnostic);
    }

    private boolean networkAvailable() {
        try {
            ConnectivityManager manager = getSystemService(ConnectivityManager.class);
            NetworkCapabilities capabilities = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
            return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (RuntimeException unavailable) { return false; }
    }

    private void watchNetwork() {
        connectivityManager = getSystemService(ConnectivityManager.class);
        if (connectivityManager == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                boolean recovered = false;
                synchronized (uploadLock) {
                    if (stopping) return;
                    boolean validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                    if (validated && !network.equals(validatedNetwork)) {
                        validatedNetwork = network;
                        recovered = true;
                    } else if (!validated && network.equals(validatedNetwork)) {
                        validatedNetwork = null;
                    }
                }
                if (recovered) networkRecovered();
            }
            @Override public void onLost(Network network) {
                synchronized (uploadLock) { if (network.equals(validatedNetwork)) validatedNetwork = null; }
                scheduleUpload(0);
            }
        };
        try { connectivityManager.registerDefaultNetworkCallback(networkCallback); }
        catch (RuntimeException unavailable) {
            // Periodic reconciliation/retry still works if this firmware refuses the callback.
            networkCallback = null;
        }
    }

    private void networkRecovered() {
        if (stopping || uploadWorker.isShutdown()) return;
        try {
            uploadWorker.execute(() -> {
                if (stopping || !settings.enabled()) return;
                try {
                    // Reset old (including pre-update 15-minute) retry deadlines once per
                    // validated default-network recovery, preserving payloads and attempts.
                    queue.retryAllNow();
                    scheduleUpload(0);
                    requestHeartbeat(0);
                } catch (RuntimeException unavailable) { settings.deliveryFailure("storage"); }
            });
        } catch (java.util.concurrent.RejectedExecutionException stopped) { /* Service is stopping. */ }
    }

    private void scheduleUpload(long delayMillis) {
        synchronized (uploadLock) {
            if (stopping || uploadWorker.isShutdown()) return;
            long elapsed = SystemClock.elapsedRealtime();
            long when = Math.max(elapsed + Math.max(0, delayMillis), uploadNotBeforeElapsed);
            if (uploading) {
                requestedUploadElapsed = Math.min(requestedUploadElapsed, when);
                return;
            }
            if (pendingUpload != null && !pendingUpload.isDone() && scheduledUploadElapsed <= when) return;
            if (pendingUpload != null) pendingUpload.cancel(false);
            scheduledUploadElapsed = when;
            final long generation = ++uploadGeneration;
            try { pendingUpload = uploadWorker.schedule(() -> uploadCycle(generation), Math.max(0, when - elapsed), TimeUnit.MILLISECONDS); }
            catch (java.util.concurrent.RejectedExecutionException stopped) { /* Service is stopping. */ }
        }
    }

    private long nextUploadDelay() {
        long next = queue.nextRetryAt();
        return next < 0 ? 60_000 : Math.max(0, next - System.currentTimeMillis());
    }

    private void uploadCycle(long generation) {
        synchronized (uploadLock) {
            // A canceled task can already be waiting for this lock. It must
            // not clear the replacement task's future or requested deadline.
            if (stopping || generation != uploadGeneration) return;
            pendingUpload = null;
            scheduledUploadElapsed = Long.MAX_VALUE;
            requestedUploadElapsed = Long.MAX_VALUE;
            uploading = true;
        }
        long delay = 60_000;
        try {
            if (!settings.enabled() || stopping) return;
            delay = uploadOne();
            refreshDeliveryStatus();
        } catch (RuntimeException unavailable) {
            settings.deliveryFailure("storage");
            uploadDiagnostic = "შენახული ზარები გაგზავნას ელოდება; ხელახლა ვცდით";
            refreshDeliveryStatus();
        } finally {
            synchronized (uploadLock) {
                uploading = false;
                if (requestedUploadElapsed != Long.MAX_VALUE) delay = Math.min(delay,
                        Math.max(0, requestedUploadElapsed - SystemClock.elapsedRealtime()));
            }
            if (!stopping && settings.enabled()) scheduleUpload(delay);
        }
    }

    private int scanCalls() throws Exception {
        // Flush already received telephony transitions before deciding a row has no live session.
        liveWorker.submit(() -> {}).get(5, TimeUnit.SECONDS);
        if (BuildConfig.PHONE_PILOT && !TelecomCapture.awaitPending(5_000)) {
            // A reservation still being written must not be mistaken for a new
            // journal-only call. Retry without advancing the journal watermark.
            throw new IllegalStateException("telecom_capture_pending");
        }
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
                if (date < baseline) continue;
                final String kind;
                switch (calls.getInt(2)) {
                    case CallLog.Calls.INCOMING_TYPE: kind = CallReconciler.INCOMING; break;
                    case CallLog.Calls.MISSED_TYPE: kind = CallReconciler.MISSED; break;
                    case CallLog.Calls.REJECTED_TYPE: kind = CallReconciler.REJECTED; break;
                    default: continue; // Outgoing, voicemail and spam-blocked rows are not inquiries.
                }
                if (!CallReconciler.INCOMING.equals(kind) && date < allIncomingBaseline) continue;
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
                long duration = CallReconciler.INCOMING.equals(kind) ? Math.max(0, calls.getLong(4)) : 0;
                rows.add(new CallReconciler.Log(row, date, duration, account.subId, phone, kind,
                        date >= allIncomingBaseline));
            }
        }
        // Settle unambiguous anchors before re-evaluating their weak neighbours.
        // Never turn a deferred row into a new card until the earlier link commits.
        List<CallReconciler.Log> pendingRows = rows;
        for (int pass = 0; pass < 3 && !pendingRows.isEmpty(); pass++) {
            boolean progress = false;
            List<CallReconciler.Log> deferredRows = new ArrayList<>();
            for (CallReconciler.Result result : CallReconciler.reconcile(queue.unlinkedSessions(), pendingRows)) {
                if (result.decision == CallReconciler.Decision.MATCH && queue.linkAndComplete(result.row, result.session)) {
                    progress = true;
                } else if (result.decision == CallReconciler.Decision.NEW) {
                    String id = "android:" + installationId + ":" + result.row.rowId + ":" + result.row.dateWall;
                    queue.enqueue(id, result.row.phoneGE9, result.row.dateWall, result.row.durationSeconds, result.row.kind);
                    progress = true;
                } else deferredRows.add(result.row);
            }
            pendingRows = deferredRows;
            if (!progress) break;
        }
        for (CallReconciler.Log row : pendingRows) {
            unresolved++;
            unresolvedRow = Math.min(unresolvedRow, row.rowId);
            unresolvedDate = Math.min(unresolvedDate, row.dateWall);
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

    private long uploadOne() {
        if (settings.authPaused()) {
            uploadDiagnostic = "კავშირი შეჩერებულია — ხელახლა დააკავშირეთ ტელეფონი";
            return 60_000;
        }
        if (queue.pendingCount() == 0) {
            uploadDiagnostic = "მონიტორინგი ჩართულია · რიგი ცარიელია; ველოდებით ახალ ზარს";
            return 60_000;
        }
        if (!networkAvailable()) {
            settings.deliveryFailure("network");
            uploadDiagnostic = "ინტერნეტს ელოდება · ზარები შენახულია ტელეფონში";
            // A due event must not make an offline zero-delay loop.
            return 60_000;
        }
        AppSettings.Binding binding = settings.binding();
        String token;
        try { token = binding.token(); }
        catch (Exception unavailable) {
            if (settings.pauseAuthenticationIfCurrent(binding)) settings.deliveryFailure("unknown");
            uploadDiagnostic = "დაკავშირების კოდი მიუწვდომელია — ხელახლა დააკავშირეთ ტელეფონი";
            return 60_000;
        }
        CallQueue.Event event = queue.nextDue(System.currentTimeMillis());
        if (event == null) return nextUploadDelay();
        if (!settings.bindingCurrent(binding)) return 0;
        try {
            URL endpoint = new URL(binding.server + "/api/integrations/android/calls");
            if (!"https".equalsIgnoreCase(endpoint.getProtocol())) throw new IllegalStateException("https_required");
            HttpURLConnection active = (HttpURLConnection) endpoint.openConnection();
            connection = active;
            active.setInstanceFollowRedirects(false);
            active.setConnectTimeout(8_000);
            active.setReadTimeout(10_000);
            active.setRequestMethod("POST");
            active.setRequestProperty("Authorization", "Bearer " + token);
            active.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            active.setRequestProperty("Accept", "application/json");
            active.setDoOutput(true);
            JSONObject payload = new JSONObject();
            payload.put("eventId", event.id);
            payload.put("phone", event.phone == null ? JSONObject.NULL : event.phone);
            payload.put("occurredAt", Instant.ofEpochMilli(event.occurredAt).toString());
            payload.put("durationSeconds", event.duration);
            payload.put("kind", event.kind);
            if (!event.legacyPayload) payload.put("phase", event.phase);
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            active.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream output = active.getOutputStream()) { output.write(body); }
            int responseCode = active.getResponseCode();
            if (responseCode == 401 || responseCode == 403) {
                if (settings.pauseAuthenticationIfCurrent(binding)) settings.deliveryFailure("http_" + responseCode);
                uploadDiagnostic = "კავშირი გაუქმებულია — ხელახლა დააკავშირეთ ტელეფონი";
                return 60_000;
            }
            if (responseCode >= 200 && responseCode < 300) {
                JSONObject response = new JSONObject(readLimited(active.getInputStream()));
                if (response.optString("id", "").isEmpty()) throw new IllegalStateException("response_invalid");
                if (!settings.bindingCurrent(binding)) return 0;
                queue.delivered(event);
                settings.deliverySucceeded();
                requestHeartbeat(0);
                synchronized (uploadLock) {
                    // Pace a recovered backlog: two working phones together
                    // stay within the server's normal 120-call-events/minute limit.
                    uploadNotBeforeElapsed = Math.max(uploadNotBeforeElapsed, SystemClock.elapsedRealtime() + 1_000);
                }
                uploadDiagnostic = queue.pendingCount() == 0
                        ? "მონიტორინგი ჩართულია · რიგი ცარიელია; ველოდებით ახალ ზარს"
                        : "ზარი მიღებულია · დარჩენილი ზარები იგზავნება";
                // Re-select after every HTTP request: a newly answered call must
                // not wait behind a stale twenty-event snapshot.
                return nextUploadDelay();
            }
            queue.retry(event, "http_" + responseCode);
            settings.deliveryFailure("http_" + responseCode);
            requestHeartbeat(0);
            uploadDiagnostic = "სერვერი მიუწვდომელია (" + responseCode + ") · ზარები შენახულია";
            long retryDelay = 3_000;
            if (responseCode == 429) {
                try { retryDelay = Math.max(3_000, Math.min(300_000,
                        Long.parseLong(active.getHeaderField("Retry-After")) * 1_000)); }
                catch (RuntimeException unavailable) { retryDelay = 60_000; }
                synchronized (uploadLock) { uploadNotBeforeElapsed = SystemClock.elapsedRealtime() + retryDelay; }
            }
            return Math.max(retryDelay, nextUploadDelay());
        } catch (Exception transientFailure) {
            if (!stopping && settings.enabled() && settings.bindingCurrent(binding)) {
                queue.retry(event, "connection_failed");
                settings.deliveryFailure("network");
                requestHeartbeat(0);
            }
            uploadDiagnostic = "კავშირი ვერ შესრულდა · ზარები შენახულია; ხელახლა ვცდით";
            return 3_000;
        } finally {
            HttpURLConnection active = connection;
            connection = null;
            if (active != null) active.disconnect();
        }
    }

    private String heartbeatError() {
        String code = settings.deliveryError();
        if (code.isEmpty()) code = queue.lastErrorCode();
        if (code.isEmpty()) return null;
        if (code.equals("connection_failed") || code.equals("network_unavailable")) return "network";
        return code.matches("^(network|http_[1-5][0-9]{2}|permission|storage|unknown)$") ? code : "unknown";
    }

    private void requestHeartbeat(long delayMillis) {
        synchronized (heartbeatLock) {
            if (stopping || heartbeatWorker.isShutdown()) return;
            heartbeatPolicy.request(SystemClock.elapsedRealtime(), Math.max(0, delayMillis));
            armHeartbeatLocked();
        }
    }

    /** Caller holds heartbeatLock. Bursts share one pending request and one connection. */
    private void armHeartbeatLocked() {
        if (stopping || heartbeatWorker.isShutdown() || heartbeating) return;
        long next = heartbeatPolicy.nextAt();
        if (next < 0) return;
        if (pendingHeartbeat != null && !pendingHeartbeat.isDone() && scheduledHeartbeatElapsed <= next) return;
        if (pendingHeartbeat != null) pendingHeartbeat.cancel(false);
        scheduledHeartbeatElapsed = next;
        final long generation = ++heartbeatGeneration;
        try {
            pendingHeartbeat = heartbeatWorker.schedule(() -> heartbeatCycle(generation),
                    Math.max(0, next - SystemClock.elapsedRealtime()), TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.RejectedExecutionException stopped) { /* Service is stopping. */ }
    }

    private void heartbeatCycle(long generation) {
        synchronized (heartbeatLock) {
            if (stopping || generation != heartbeatGeneration) return;
            pendingHeartbeat = null;
            scheduledHeartbeatElapsed = Long.MAX_VALUE;
            if (!heartbeatPolicy.begin(SystemClock.elapsedRealtime())) {
                armHeartbeatLocked();
                return;
            }
            heartbeating = true;
        }
        try { sendHeartbeat(); }
        finally {
            synchronized (heartbeatLock) {
                heartbeating = false;
                armHeartbeatLocked();
            }
        }
    }

    private void sendHeartbeat() {
        if (stopping || !settings.enabled() || settings.authPaused() || !networkAvailable()) return;
        AppSettings.Binding binding = settings.binding();
        try {
            String token = binding.token();
            URL endpoint = new URL(binding.server + "/api/integrations/android/heartbeat");
            if (!"https".equalsIgnoreCase(endpoint.getProtocol())) return;
            JSONObject payload = new JSONObject();
            String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            payload.put("appVersion", version == null ? "unknown" : version.substring(0, Math.min(version.length(), 32)));
            String android = Build.VERSION.RELEASE == null ? Integer.toString(Build.VERSION.SDK_INT) : Build.VERSION.RELEASE;
            payload.put("androidVersion", android.substring(0, Math.min(android.length(), 32)));
            payload.put("monitoring", running && permissionsGranted(this));
            final int pending;
            final long oldest;
            final String error;
            synchronized (queue) {
                // The uploader/live worker can change the queue concurrently.
                // Report its count and oldest entry from one consistent snapshot.
                pending = queue.pendingCount();
                oldest = queue.oldestPendingAt();
                error = heartbeatError();
            }
            payload.put("pendingCount", Math.min(100_000, pending));
            payload.put("oldestPendingAt", oldest < 0 ? JSONObject.NULL : Instant.ofEpochMilli(oldest).toString());
            payload.put("lastError", error == null ? JSONObject.NULL : error);
            HttpURLConnection active = (HttpURLConnection) endpoint.openConnection();
            heartbeatConnection = active;
            active.setInstanceFollowRedirects(false);
            active.setConnectTimeout(8_000);
            active.setReadTimeout(10_000);
            active.setRequestMethod("POST");
            active.setRequestProperty("Authorization", "Bearer " + token);
            active.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            active.setRequestProperty("Accept", "application/json");
            active.setDoOutput(true);
            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            active.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream output = active.getOutputStream()) { output.write(body); }
            int responseCode = active.getResponseCode();
            // Heartbeat is additive. An older server, rejected status request or
            // unavailable connection must never pause or consume call events.
            if (responseCode >= 200 && responseCode < 300) {
                JSONObject response = new JSONObject(readLimited(active.getInputStream()));
                if (!response.optString("receivedAt", "").isEmpty() && settings.bindingCurrent(binding)) settings.heartbeatSucceeded();
            }
        } catch (Exception unavailable) {
            // Only the call upload result changes its persistent error/status.
        } finally {
            HttpURLConnection active = heartbeatConnection;
            heartbeatConnection = null;
            if (active != null) active.disconnect();
        }
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
        if (!settings.enabled() || stopping || worker.isShutdown()) return;
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
        stopping = true;
        synchronized (heartbeatLock) {
            heartbeatGeneration++;
            heartbeatPolicy.clear();
            if (pendingHeartbeat != null) pendingHeartbeat.cancel(false);
        }
        if (connectivityManager != null && networkCallback != null) {
            try { connectivityManager.unregisterNetworkCallback(networkCallback); }
            catch (RuntimeException unavailable) { /* Callback already removed by Android. */ }
            networkCallback = null;
        }
        if (observer != null) getContentResolver().unregisterContentObserver(observer);
        if (dialerRoleReceiver != null) {
            try { unregisterReceiver(dialerRoleReceiver); }
            catch (RuntimeException unavailable) { /* Already removed by Android. */ }
            dialerRoleReceiver = null;
        }
        unregisterPhoneListeners();
        if (subscriptionManager != null && subscriptionListener != null) {
            try { subscriptionManager.removeOnSubscriptionsChangedListener(subscriptionListener); }
            catch (RuntimeException unavailable) { /* No account data is logged. */ }
        }
        liveWorker.shutdownNow();
        worker.shutdownNow();
        uploadWorker.shutdownNow();
        heartbeatWorker.shutdownNow();
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
        HttpURLConnection statusConnection = heartbeatConnection;
        if (statusConnection != null) statusConnection.disconnect();
        stopForeground(STOP_FOREGROUND_REMOVE);
        // Close SQLite after workers leave their transactions, not underneath an active enqueue.
        new Thread(() -> {
            try {
                if (liveWorker.awaitTermination(5, TimeUnit.SECONDS) && worker.awaitTermination(20, TimeUnit.SECONDS)
                        && uploadWorker.awaitTermination(20, TimeUnit.SECONDS) && heartbeatWorker.awaitTermination(20, TimeUnit.SECONDS)) {
                    queue.close();
                }
            } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            catch (RuntimeException unavailable) { /* Process restart marks any remaining gap. */ }
        }, "greentaxi-monitor-cleanup").start();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
