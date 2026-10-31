package ge.greentaxi.calls;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.OutcomeReceiver;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.CallEndpoint;
import android.telecom.CallEndpointException;
import android.telecom.InCallService;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telecom.VideoProfile;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;

/** The system binds this UI only after the owner explicitly grants the phone role. */
@android.annotation.TargetApi(35)
public final class TaxiInCallService extends InCallService {
    private static final String INCOMING_CHANNEL = "taxi_phone_incoming_v1";
    private static final String ONGOING_CHANNEL = "taxi_phone_ongoing_v1";
    static final String ACTION_ANSWER = "ge.greentaxi.calls.ANSWER";
    private static final String ACTION_REJECT = "ge.greentaxi.calls.REJECT";
    private static final String ACTION_END = "ge.greentaxi.calls.END";
    static final String EXTRA_CALL = "phone_call";
    private static final CopyOnWriteArraySet<Runnable> listeners = new CopyOnWriteArraySet<>();
    private static TaxiInCallService instance;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Call, Entry> calls = new LinkedHashMap<>();
    private List<CallEndpoint> endpoints = new ArrayList<>();
    private TelecomCapture capture;
    private boolean muted;

    static final class Entry {
        final String id;
        final int notificationId;
        final Call call;
        Call.Callback callback;
        String postDial;
        Entry(String id, int notificationId, Call call) {
            this.id = id; this.notificationId = notificationId; this.call = call;
        }
    }

    static TaxiInCallService getInstance() { return instance; }
    static void addListener(Runnable listener) { listeners.add(listener); }
    static void removeListener(Runnable listener) { listeners.remove(listener); }
    List<Entry> getCallsSnapshot() { return new ArrayList<>(calls.values()); }
    boolean isMuted() { return muted; }
    boolean isSpeaker() {
        try {
            CallEndpoint endpoint = getCurrentCallEndpoint();
            return endpoint != null && endpoint.getEndpointType() == CallEndpoint.TYPE_SPEAKER;
        } catch (RuntimeException unavailable) { return false; }
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        try { capture = new TelecomCapture(this); }
        catch (RuntimeException unavailable) { /* The phone UI remains available if local capture fails. */ }
        NotificationManager notifications = getSystemService(NotificationManager.class);
        NotificationChannel incoming = new NotificationChannel(INCOMING_CHANNEL,
                "შემომავალი ზარები", NotificationManager.IMPORTANCE_HIGH);
        // Telecom retains responsibility for the actual ringtone and vibration.
        incoming.setSound(null, null);
        incoming.enableVibration(false);
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        notifications.createNotificationChannel(incoming);
        NotificationChannel ongoing = new NotificationChannel(ONGOING_CHANNEL,
                "მიმდინარე საუბარი", NotificationManager.IMPORTANCE_LOW);
        ongoing.setSound(null, null);
        notifications.createNotificationChannel(ongoing);
    }

    @Override public void onCallAdded(Call call) {
        super.onCallAdded(call);
        Entry existing = calls.get(call);
        if (existing != null) { changed(existing); return; }
        String identity = notificationIdentity(call);
        int notificationId = identity.hashCode() & 0x7fffffff;
        boolean collision;
        do {
            collision = false;
            for (Entry current : calls.values()) if (current.notificationId == notificationId) { collision = true; break; }
            if (collision) notificationId = (notificationId + 1) & 0x7fffffff;
        } while (collision);
        Entry entry = new Entry(identity, notificationId, call);
        calls.put(call, entry);
        entry.callback = new Call.Callback() {
            @Override public void onStateChanged(Call changed, int state) { changed(entry); }
            @Override public void onDetailsChanged(Call changed, Call.Details details) { changed(entry); }
            @Override public void onParentChanged(Call changed, Call parent) { changed(entry); }
            @Override public void onChildrenChanged(Call changed, List<Call> children) { changed(entry); }
            @Override public void onPostDialWait(Call changed, String remaining) {
                entry.postDial = remaining;
                notifyListeners();
                showPhone();
            }
        };
        call.registerCallback(entry.callback, main);
        // Snapshot synchronously; persistence and upload are delegated off the UI thread.
        observe(call, false);
        updateNotification(entry);
        notifyListeners();
        if (call.getState() != Call.STATE_RINGING) showPhone();
    }

    private void changed(Entry entry) {
        if (!calls.containsKey(entry.call)) return;
        observe(entry.call, false);
        updateNotification(entry);
        notifyListeners();
    }

    private void observe(Call call, boolean removed) {
        if (capture == null) return;
        try {
            if (removed) capture.removed(call); else capture.observe(call);
        } catch (RuntimeException unavailable) {
            // The independent call-log recovery remains enabled in the monitor.
        }
    }

    private static String notificationIdentity(Call call) {
        Call.Details details = call.getDetails();
        String id = details == null ? null : details.getId();
        if (id == null || id.isEmpty() || details.getCreationTimeMillis() <= 0) return UUID.randomUUID().toString();
        // Telecom's call ID is global to the phone process. Creation time prevents
        // reuse across boots, without a late-arriving SIM account changing the key.
        String source = id + ":" + details.getCreationTimeMillis();
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(source.getBytes(StandardCharsets.UTF_8));
            StringBuilder encoded = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) encoded.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return encoded.toString();
        } catch (NoSuchAlgorithmException unavailable) { return UUID.randomUUID().toString(); }
    }

    @Override public void onCallRemoved(Call call) {
        observe(call, true);
        Entry entry = calls.remove(call);
        if (entry != null) {
            call.unregisterCallback(entry.callback);
            getSystemService(NotificationManager.class).cancel(entry.id, entry.notificationId);
        }
        notifyListeners();
        super.onCallRemoved(call);
    }

    @Override public void onBringToForeground(boolean showDialpad) { showPhone(); }
    @Override public void onCanAddCallChanged(boolean canAddCall) { notifyListeners(); }

    private void showPhone() {
        try {
            startActivity(new Intent(this, CallActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        } catch (RuntimeException restricted) {
            // Each call remains actionable through its system call notification.
        }
    }

    private PendingIntent callAction(Entry entry, String action) {
        if (ACTION_ANSWER.equals(action)) {
            // A direct Activity PendingIntent can both answer and display the
            // ongoing controls without Android's notification-trampoline restriction.
            Intent answer = new Intent(this, CallActivity.class).setAction(action)
                    .setData(Uri.parse("greentaxi-phone:answer/" + entry.id))
                    .putExtra(EXTRA_CALL, entry.id)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            return PendingIntent.getActivity(this, entry.notificationId, answer,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }
        Intent intent = new Intent(this, TaxiInCallService.class).setAction(action)
                .setData(Uri.parse("greentaxi-phone:call/" + entry.id + "/" + action))
                .putExtra(EXTRA_CALL, entry.id);
        return PendingIntent.getService(this, entry.notificationId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent openCall(Entry entry) {
        Intent intent = new Intent(this, CallActivity.class)
                .setData(Uri.parse("greentaxi-phone:open/" + entry.id))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, entry.notificationId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void updateNotification(Entry entry) {
        int state = entry.call.getState();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        if (state == Call.STATE_DISCONNECTED || state == Call.STATE_DISCONNECTING) {
            notifications.cancel(entry.id, entry.notificationId);
            return;
        }
        boolean ringing = state == Call.STATE_RINGING;
        Person caller = new Person.Builder().setName(displayNumber(entry.call)).setImportant(true).build();
        PendingIntent open = openCall(entry);
        Notification.Builder builder = new Notification.Builder(this,
                ringing ? INCOMING_CHANNEL : ONGOING_CHANNEL)
                .setSmallIcon(R.drawable.ic_taxi)
                .setContentTitle(displayNumber(entry.call))
                .setContentText(stateLabel(entry.call))
                .setContentIntent(open)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        if (ringing) {
            builder.setStyle(Notification.CallStyle.forIncomingCall(caller,
                    callAction(entry, ACTION_REJECT), callAction(entry, ACTION_ANSWER)))
                    .setFullScreenIntent(open, true);
        } else {
            builder.setStyle(Notification.CallStyle.forOngoingCall(caller,
                    callAction(entry, ACTION_END)));
        }
        NotificationChannel channel = notifications.getNotificationChannel(ringing ? INCOMING_CHANNEL : ONGOING_CHANNEL);
        if (!notifications.areNotificationsEnabled()
                || (channel != null && (channel.getImportance() == NotificationManager.IMPORTANCE_NONE
                || (ringing && channel.getImportance() < NotificationManager.IMPORTANCE_HIGH)))) {
            showPhone();
        }
        try { notifications.notify(entry.id, entry.notificationId, builder.build()); }
        catch (SecurityException denied) { showPhone(); }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            Entry entry = find(intent.getStringExtra(EXTRA_CALL));
            if (entry != null) {
                String action = intent.getAction();
                if (ACTION_ANSWER.equals(action)) answer(entry);
                else if (ACTION_REJECT.equals(action)) reject(entry);
                else if (ACTION_END.equals(action)) end(entry);
            }
        }
        stopSelf(startId);
        return START_NOT_STICKY;
    }

    Entry find(String id) {
        if (id == null) return null;
        for (Entry entry : calls.values()) if (entry.id.equals(id)) return entry;
        return null;
    }

    void answer(Entry entry) {
        if (entry.call.getState() == Call.STATE_RINGING) safe(() -> entry.call.answer(VideoProfile.STATE_AUDIO_ONLY));
    }
    void reject(Entry entry) {
        if (entry.call.getState() == Call.STATE_RINGING) safe(() -> entry.call.reject(Call.REJECT_REASON_DECLINED));
    }
    void end(Entry entry) { safe(entry.call::disconnect); }
    void hold(Entry entry) {
        if (entry.call.getState() == Call.STATE_ACTIVE && entry.call.getDetails().can(Call.Details.CAPABILITY_HOLD))
            safe(entry.call::hold);
    }
    void unhold(Entry entry) { safe(entry.call::unhold); }
    void toggleMute() { safe(() -> setMuted(!muted)); }
    void chooseEndpoint(CallEndpoint endpoint) {
        safe(() -> requestCallEndpointChange(endpoint, getMainExecutor(), new OutcomeReceiver<Void, CallEndpointException>() {
            @Override public void onResult(Void ignored) { notifyListeners(); }
            @Override public void onError(CallEndpointException error) { message("ხმის მოწყობილობა ვერ შეიცვალა"); }
        }));
    }
    List<CallEndpoint> availableEndpoints() { return new ArrayList<>(endpoints); }
    void dtmf(Entry entry, char digit) {
        safe(() -> entry.call.playDtmfTone(digit));
        main.postDelayed(() -> safe(entry.call::stopDtmfTone), 250);
    }
    void postDial(Entry entry, boolean proceed) {
        entry.postDial = null;
        safe(() -> entry.call.postDialContinue(proceed));
        notifyListeners();
    }

    List<PhoneAccountHandle> availableAccounts(Entry entry) {
        Bundle extras = entry.call.getDetails().getIntentExtras();
        List<PhoneAccountHandle> accounts = extras == null ? null
                : extras.getParcelableArrayList(Call.AVAILABLE_PHONE_ACCOUNTS, PhoneAccountHandle.class);
        if (accounts == null) {
            extras = entry.call.getDetails().getExtras();
            accounts = extras == null ? null
                    : extras.getParcelableArrayList(Call.AVAILABLE_PHONE_ACCOUNTS, PhoneAccountHandle.class);
        }
        if (accounts != null) return accounts;
        try { return getSystemService(TelecomManager.class).getCallCapablePhoneAccounts(); }
        catch (SecurityException unavailable) { return new ArrayList<>(); }
    }
    String accountLabel(PhoneAccountHandle handle, int position) {
        try {
            PhoneAccount account = getSystemService(TelecomManager.class).getPhoneAccount(handle);
            if (account != null && account.getLabel() != null) return account.getLabel().toString();
        } catch (SecurityException unavailable) { /* A generic SIM label is sufficient. */ }
        return "SIM " + position;
    }
    void selectAccount(Entry entry, PhoneAccountHandle account) {
        safe(() -> entry.call.phoneAccountSelected(account, false));
    }

    @Override public void onMuteStateChanged(boolean value) { muted = value; notifyListeners(); }
    @Override public void onCallAudioStateChanged(CallAudioState state) {
        if (state != null) muted = state.isMuted();
        notifyListeners();
    }
    @Override public void onCallEndpointChanged(CallEndpoint endpoint) { notifyListeners(); }
    @Override public void onAvailableCallEndpointsChanged(List<CallEndpoint> available) {
        endpoints = new ArrayList<>(available);
        notifyListeners();
    }

    static String displayNumber(Call call) {
        Call.Details details = call.getDetails();
        if (details.hasProperty(Call.Details.PROPERTY_CONFERENCE)) return "ჯგუფური ზარი";
        if (details.getHandlePresentation() != TelecomManager.PRESENTATION_ALLOWED) return "დამალული ნომერი";
        Uri handle = details.getHandle();
        if (handle != null && handle.getSchemeSpecificPart() != null && !handle.getSchemeSpecificPart().isEmpty())
            return handle.getSchemeSpecificPart();
        return "უცნობი ნომერი";
    }
    static String stateLabel(Call call) {
        switch (call.getState()) {
            case Call.STATE_RINGING: return "შემომავალი ზარი";
            case Call.STATE_ACTIVE: return "საუბარი";
            case Call.STATE_HOLDING: return "დაყოვნებულია";
            case Call.STATE_CONNECTING:
            case Call.STATE_DIALING: return "ირეკება…";
            case Call.STATE_SELECT_PHONE_ACCOUNT: return "აირჩიეთ SIM";
            case Call.STATE_DISCONNECTING: return "სრულდება…";
            case Call.STATE_DISCONNECTED: return "ზარი დასრულდა";
            default: return "ზარი მზადდება…";
        }
    }
    private void notifyListeners() {
        for (Runnable listener : listeners) {
            try { listener.run(); }
            catch (RuntimeException unavailable) { /* A stale activity never interrupts phone control. */ }
        }
    }
    private void safe(Runnable action) {
        try { action.run(); }
        catch (RuntimeException unavailable) { message("მოქმედება ვერ შესრულდა. სცადეთ ხელახლა."); }
    }
    private void message(String value) { Toast.makeText(this, value, Toast.LENGTH_SHORT).show(); }

    @Override public void onDestroy() {
        for (Entry entry : calls.values()) {
            entry.call.unregisterCallback(entry.callback);
            getSystemService(NotificationManager.class).cancel(entry.id, entry.notificationId);
        }
        calls.clear();
        main.removeCallbacksAndMessages(null);
        if (capture != null) {
            try { capture.close(); } catch (RuntimeException unavailable) { /* Never interrupt system cleanup. */ }
        }
        if (instance == this) instance = null;
        notifyListeners();
        super.onDestroy();
    }
}
