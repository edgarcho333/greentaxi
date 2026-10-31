package ge.greentaxi.calls;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.media.AudioManager;
import android.telecom.Call;
import android.telecom.CallEndpoint;
import android.telecom.PhoneAccountHandle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The complete incoming/ongoing phone UI; backend settings never gate answering. */
@android.annotation.TargetApi(35)
public final class CallActivity extends Activity {
    private static final int GREEN = Color.rgb(0, 126, 69);
    private static final int RED = Color.rgb(179, 34, 47);
    private static final int INK = Color.rgb(20, 55, 41);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<DurationLabel> durations = new ArrayList<>();
    private final Runnable changed = this::render;
    private LinearLayout content;
    private boolean keypadShown;
    private String keypadCallId;
    private AlertDialog postDialDialog;
    private String postDialShown;
    private PowerManager.WakeLock proximity;
    private boolean started;
    private String pendingAnswerId;
    private long pendingAnswerUntil;
    private final Runnable clock = new Runnable() {
        @Override public void run() {
            for (DurationLabel label : durations) label.refresh();
            if (pendingAnswerId != null && SystemClock.elapsedRealtime() >= pendingAnswerUntil) {
                pendingAnswerId = null;
                render();
                Toast.makeText(CallActivity.this, "პასუხისთვის დააჭირეთ ზარის ბარათზე „პასუხი“", Toast.LENGTH_LONG).show();
            }
            handler.postDelayed(this, 1000);
        }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        setVolumeControlStream(AudioManager.STREAM_VOICE_CALL);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (saved != null) {
            keypadShown = saved.getBoolean("keypad_shown");
            keypadCallId = saved.getString("keypad_call");
            pendingAnswerId = saved.getString("pending_answer");
            pendingAnswerUntil = saved.getLong("pending_answer_until");
        }
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(239, 247, 242));
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(16);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            content.setPadding(padding + bars.left, padding + bars.top, padding + bars.right, padding + bars.bottom);
            return insets;
        });
        setContentView(scroll);
        handleAction(getIntent());
        render();
    }

    @Override protected void onStart() {
        super.onStart();
        started = true;
        TaxiInCallService.addListener(changed);
        render();
        handler.post(clock);
    }
    @Override protected void onStop() {
        TaxiInCallService.removeListener(changed);
        started = false;
        releaseProximity();
        if (postDialDialog != null) postDialDialog.dismiss();
        postDialDialog = null;
        postDialShown = null;
        handler.removeCallbacks(clock);
        super.onStop();
    }
    @Override protected void onDestroy() {
        if (postDialDialog != null) postDialDialog.dismiss();
        releaseProximity();
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAction(intent);
        render();
    }

    private void handleAction(Intent intent) {
        if (intent == null || !TaxiInCallService.ACTION_ANSWER.equals(intent.getAction())) return;
        pendingAnswerId = intent.getStringExtra(TaxiInCallService.EXTRA_CALL);
        pendingAnswerUntil = SystemClock.elapsedRealtime() + 10_000;
        intent.setAction(null);
    }

    private void answerWhenBound(TaxiInCallService service) {
        if (pendingAnswerId == null || service == null) return;
        if (SystemClock.elapsedRealtime() >= pendingAnswerUntil) { pendingAnswerId = null; return; }
        TaxiInCallService.Entry entry = service.find(pendingAnswerId);
        if (entry == null) return;
        pendingAnswerId = null;
        service.answer(entry);
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        out.putBoolean("keypad_shown", keypadShown);
        out.putString("keypad_call", keypadCallId);
        out.putString("pending_answer", pendingAnswerId);
        out.putLong("pending_answer_until", pendingAnswerUntil);
        super.onSaveInstanceState(out);
    }

    private void render() {
        if (content == null || isFinishing() || isDestroyed()) return;
        TaxiInCallService service = TaxiInCallService.getInstance();
        answerWhenBound(service);
        List<TaxiInCallService.Entry> calls = service == null ? new ArrayList<>() : service.getCallsSnapshot();
        content.removeAllViews();
        durations.clear();
        TextView title = text("Green Taxi · ტელეფონი", 21, true);
        add(content, title, 4);
        if (calls.isEmpty()) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            releaseProximity();
            add(content, text(pendingAnswerId == null ? "მიმდინარე ზარი არ არის" : "ზარი ირთვება…", 24, true), 32);
            add(content, button("ნომრის აკრეფა", GREEN,
                    () -> startActivity(new Intent(this, PhoneActivity.class))), 24);
            add(content, button("დახურვა", INK, this::finish), 12);
            return;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        boolean active = false;
        TaxiInCallService.Entry held = null;
        TaxiInCallService.Entry dtmfCall = null;
        for (TaxiInCallService.Entry entry : calls) {
            int state = entry.call.getState();
            if (state == Call.STATE_ACTIVE) {
                active = true;
                if (dtmfCall == null || entry.id.equals(keypadCallId)) dtmfCall = entry;
            }
            if (state == Call.STATE_HOLDING) held = entry;
            addCard(service, entry);
        }
        if (active && held != null) {
            TaxiInCallService.Entry swapTarget = held;
            add(content, button("ზარების შეცვლა", GREEN, () -> service.unhold(swapTarget)), 12);
        }
        if (active || held != null) {
            LinearLayout audio = row();
            addCell(audio, button(service.isMuted() ? "მიკროფონი გამორთულია" : "მიკროფონი", INK,
                    service::toggleMute));
            addCell(audio, button(service.isSpeaker() ? "დინამიკი ჩართულია" : "ხმა / დინამიკი", INK,
                    () -> selectAudio(service)));
            add(content, audio, 14);
        }
        if (dtmfCall != null) {
            TaxiInCallService.Entry target = dtmfCall;
            add(content, button(keypadShown ? "კლავიატურის დამალვა" : "კლავიატურა", INK, () -> {
                keypadShown = !keypadShown;
                keypadCallId = target.id;
                render();
            }), 12);
            if (keypadShown) addDtmf(service, target);
        }
        Button newCall = button("ახალი ზარი", INK,
                () -> startActivity(new Intent(this, PhoneActivity.class)));
        newCall.setEnabled(service.canAddCall());
        add(content, newCall, 16);
        updateProximity(service, active);
        boolean pendingPostDial = false;
        for (TaxiInCallService.Entry entry : calls) {
            if (entry.postDial != null) pendingPostDial = true;
            String postDialKey = entry.id + ":" + entry.postDial;
            if (entry.postDial != null && !postDialKey.equals(postDialShown) && started) {
                postDialShown = postDialKey;
                if (postDialDialog != null) postDialDialog.dismiss();
                String remaining = entry.postDial.length() > 80 ? entry.postDial.substring(0, 80) : entry.postDial;
                postDialDialog = new AlertDialog.Builder(this)
                        .setTitle("დამატებითი ციფრების გაგზავნა?")
                        .setMessage(remaining)
                        .setPositiveButton("გაგზავნა", (dialog, which) -> service.postDial(entry, true))
                        .setNegativeButton("გაუქმება", (dialog, which) -> service.postDial(entry, false))
                        .setOnCancelListener(dialog -> service.postDial(entry, false))
                        .show();
                break;
            }
        }
        if (!pendingPostDial) {
            postDialShown = null;
            if (postDialDialog != null) postDialDialog.dismiss();
            postDialDialog = null;
        }
    }

    private void updateProximity(TaxiInCallService service, boolean active) {
        boolean earpiece = false;
        try {
            CallEndpoint endpoint = service.getCurrentCallEndpoint();
            earpiece = endpoint != null && endpoint.getEndpointType() == CallEndpoint.TYPE_EARPIECE;
        } catch (RuntimeException unavailable) { /* Do not blank the screen unless the route is known. */ }
        if (!started || !active || !earpiece) { releaseProximity(); return; }
        try {
            PowerManager power = getSystemService(PowerManager.class);
            if (power == null || !power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
            if (proximity == null) {
                proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,
                        getPackageName() + ":phone-proximity");
                proximity.setReferenceCounted(false);
            }
            if (!proximity.isHeld()) proximity.acquire();
        } catch (RuntimeException unavailable) { releaseProximity(); }
    }

    private void releaseProximity() {
        if (proximity != null && proximity.isHeld()) proximity.release();
    }

    private void addCard(TaxiInCallService service, TaxiInCallService.Entry entry) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadius(dp(14));
        background.setStroke(dp(2), Color.rgb(187, 214, 197));
        card.setBackground(background);
        TextView state = text(TaxiInCallService.stateLabel(entry.call), 18, true);
        add(card, state, 0);
        TextView number = text(TaxiInCallService.displayNumber(entry.call), 29, true);
        number.setTextIsSelectable(true);
        number.setGravity(Gravity.CENTER_HORIZONTAL);
        add(card, number, 10);
        long connect = entry.call.getDetails().getConnectTimeMillis();
        if (connect > 0 && (entry.call.getState() == Call.STATE_ACTIVE || entry.call.getState() == Call.STATE_HOLDING)) {
            TextView duration = text("", 18, false);
            duration.setGravity(Gravity.CENTER_HORIZONTAL);
            DurationLabel label = new DurationLabel(duration, connect);
            label.refresh();
            durations.add(label);
            add(card, duration, 4);
        }
        int callState = entry.call.getState();
        if (callState == Call.STATE_RINGING) {
            LinearLayout actions = row();
            addCell(actions, button("უარყოფა", RED, () -> service.reject(entry)));
            addCell(actions, button("პასუხი", GREEN, () -> service.answer(entry)));
            add(card, actions, 16);
        } else if (callState == Call.STATE_SELECT_PHONE_ACCOUNT) {
            List<PhoneAccountHandle> accounts = service.availableAccounts(entry);
            if (accounts.isEmpty()) add(card, text("SIM მიუწვდომელია. შეამოწმეთ ტელეფონის ქსელი.", 16, false), 12);
            int position = 0;
            for (PhoneAccountHandle account : accounts) {
                position++;
                add(card, button(service.accountLabel(account, position), GREEN,
                        () -> service.selectAccount(entry, account)), 10);
            }
            add(card, button("გაუქმება", RED, () -> service.end(entry)), 10);
        } else if (callState != Call.STATE_DISCONNECTED && callState != Call.STATE_DISCONNECTING) {
            LinearLayout actions = row();
            if (callState == Call.STATE_HOLDING) {
                addCell(actions, button("გაგრძელება", GREEN, () -> service.unhold(entry)));
            } else if (callState == Call.STATE_ACTIVE && entry.call.getDetails().can(Call.Details.CAPABILITY_HOLD)) {
                addCell(actions, button("დაყოვნება", INK, () -> service.hold(entry)));
            }
            addCell(actions, button("დასრულება", RED, () -> service.end(entry)));
            add(card, actions, 16);
        } else {
            CharSequence description = entry.call.getDetails().getDisconnectCause() == null ? null
                    : entry.call.getDetails().getDisconnectCause().getDescription();
            if (description != null && description.length() > 0) add(card, text(description.toString(), 16, false), 8);
        }
        add(content, card, 14);
    }

    private void selectAudio(TaxiInCallService service) {
        List<CallEndpoint> endpoints = service.availableEndpoints();
        if (endpoints.isEmpty()) return;
        String[] labels = new String[endpoints.size()];
        for (int i = 0; i < endpoints.size(); i++) {
            CallEndpoint endpoint = endpoints.get(i);
            switch (endpoint.getEndpointType()) {
                case CallEndpoint.TYPE_EARPIECE: labels[i] = "ტელეფონი"; break;
                case CallEndpoint.TYPE_SPEAKER: labels[i] = "დინამიკი"; break;
                case CallEndpoint.TYPE_WIRED_HEADSET: labels[i] = "ყურსასმენი"; break;
                default: labels[i] = endpoint.getEndpointName().toString(); break;
            }
        }
        new AlertDialog.Builder(this).setTitle("ხმის მოწყობილობა")
                .setItems(labels, (dialog, position) -> service.chooseEndpoint(endpoints.get(position)))
                .setNegativeButton("გაუქმება", null).show();
    }

    private void addDtmf(TaxiInCallService service, TaxiInCallService.Entry entry) {
        String[] rows = {"123", "456", "789", "*0#"};
        for (String digits : rows) {
            LinearLayout row = row();
            for (char digit : digits.toCharArray()) {
                Button key = button(Character.toString(digit), INK, () -> service.dtmf(entry, digit));
                key.setTextSize(26);
                key.setContentDescription("ტონი " + digit);
                addCell(row, key);
            }
            add(content, row, 8);
        }
    }

    private TextView text(String value, int size, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(INK);
        view.setTextSize(size);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }
    private Button button(String label, int color, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(17);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setMinHeight(dp(58));
        button.setPadding(dp(8), dp(12), dp(8), dp(12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(10));
        button.setBackground(background);
        button.setOnClickListener(view -> action.run());
        return button;
    }
    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        return row;
    }
    private void addCell(LinearLayout row, View view) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        if (row.getChildCount() > 0) params.leftMargin = dp(8);
        row.addView(view, params);
    }
    private void add(LinearLayout parent, View view, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top);
        parent.addView(view, params);
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static final class DurationLabel {
        final TextView view;
        final long connect;
        DurationLabel(TextView view, long connect) { this.view = view; this.connect = connect; }
        void refresh() {
            long seconds = Math.max(0, System.currentTimeMillis() - connect) / 1000;
            view.setText(String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60));
        }
    }
}
