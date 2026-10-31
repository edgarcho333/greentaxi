package ge.greentaxi.calls;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.TelecomManager;
import android.text.InputFilter;
import android.text.InputType;
import android.text.method.DigitsKeyListener;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** A real ACTION_DIAL screen. No intent or permission callback ever places a call. */
public final class PhoneActivity extends Activity {
    private static final int CALL_PERMISSION = 73;
    private static final int GREEN = Color.rgb(0, 132, 72);
    private static final int INK = Color.rgb(24, 52, 40);
    private static final int LIMIT = 64;
    private EditText number;
    private TextView roleStatus;
    private Button callButton;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("Green Taxi — ტელეფონი");
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(242, 247, 244));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(20);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                content.setPadding(padding + bars.left, padding + bars.top, padding + bars.right, padding + bars.bottom);
                return insets;
            });
        }

        TextView title = text("Green Taxi", 25);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextColor(GREEN);
        add(content, title, 0);
        add(content, text("ნომრის აკრეფა", 21), 4);
        roleStatus = text("", 14);
        add(content, roleStatus, 8);

        number = new EditText(this);
        number.setSingleLine(true);
        number.setInputType(InputType.TYPE_CLASS_PHONE);
        number.setKeyListener(DigitsKeyListener.getInstance("0123456789+*# ,;"));
        number.setShowSoftInputOnFocus(false);
        number.setFilters(new InputFilter[]{new InputFilter.LengthFilter(LIMIT)});
        number.setHint("ტელეფონის ნომერი");
        number.setTextSize(27);
        number.setTextColor(INK);
        number.setGravity(Gravity.CENTER);
        number.setMinHeight(dp(66));
        number.setPadding(dp(10), dp(12), dp(10), dp(12));
        number.setBackground(background(Color.WHITE, Color.rgb(177, 205, 189)));
        number.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        number.setContentDescription("ტელეფონის ნომერი");
        add(content, number, 18);

        String[] digits = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"};
        for (int row = 0; row < 4; row++) {
            LinearLayout keys = new LinearLayout(this);
            keys.setOrientation(LinearLayout.HORIZONTAL);
            for (int column = 0; column < 3; column++) {
                String digit = digits[row * 3 + column];
                Button key = button(digit, false, () -> append(digit));
                key.setTextSize(27);
                key.setMinHeight(dp(66));
                if (digit.equals("0")) {
                    key.setContentDescription("0, ხანგრძლივი დაჭერა პლუსისთვის");
                    key.setOnLongClickListener(view -> { append("+"); return true; });
                }
                LinearLayout.LayoutParams item = new LinearLayout.LayoutParams(0, -2, 1);
                if (column > 0) item.leftMargin = dp(8);
                keys.addView(key, item);
            }
            add(content, keys, 8);
        }

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        callButton = button("დარეკვა", true, this::placeCall);
        LinearLayout.LayoutParams callParams = new LinearLayout.LayoutParams(0, -2, 2);
        actions.addView(callButton, callParams);
        Button erase = button("წაშლა", false, this::erase);
        erase.setOnLongClickListener(view -> { number.setText(""); return true; });
        LinearLayout.LayoutParams eraseParams = new LinearLayout.LayoutParams(0, -2, 1);
        eraseParams.leftMargin = dp(8);
        actions.addView(erase, eraseParams);
        add(content, actions, 12);
        add(content, button("მიმდინარე ზარი", false,
                () -> startActivity(new Intent(this, CallActivity.class))), 12);
        add(content, button("დაკავშირება და პარამეტრები", false,
                () -> startActivity(new Intent(this, MainActivity.class))), 8);
        add(content, text("გამავალი ზარი ოპერატორის განაცხადებში არ ემატება.", 13), 10);
        setContentView(scroll);
        if (savedInstanceState == null) readDialIntent(getIntent());
        else {
            number.setText(savedInstanceState.getString("dialNumber", ""));
            int selection = savedInstanceState.getInt("dialSelection", number.length());
            number.setSelection(Math.max(0, Math.min(selection, number.length())));
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("dialNumber", number.getText().toString());
        state.putInt("dialSelection", Math.max(0, number.getSelectionStart()));
        super.onSaveInstanceState(state);
    }

    @Override protected void onResume() {
        super.onResume();
        refreshRole();
        callButton.setEnabled(true);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readDialIntent(intent);
    }

    private void readDialIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"tel".equalsIgnoreCase(data.getScheme())) return;
        String supplied = data.getSchemeSpecificPart();
        // External dial intents only prefill. Unbounded data and non-number URI
        // parameters never reach TelecomManager or an automatic outgoing call.
        if (supplied == null || supplied.length() > 256) {
            message("ნომერი ვერ გაიხსნა — აკრიფეთ ხელით");
            return;
        }
        String dialable = normalize(supplied);
        if (dialable == null) {
            message("ნომერი ვერ გაიხსნა — აკრიფეთ ხელით");
            return;
        }
        number.setText(dialable);
        number.setSelection(number.length());
    }

    private void refreshRole() {
        TelecomManager telecom = getSystemService(TelecomManager.class);
        boolean selected = telecom != null && getPackageName().equals(telecom.getDefaultDialerPackage());
        roleStatus.setText(selected
                ? "Green Taxi — ძირითადი ტელეფონის აპი"
                : "შემომავალი ზარების სამართავად პარამეტრებში აირჩიეთ Green Taxi ძირითად ტელეფონის აპად.");
    }

    private void append(String digit) {
        int start = Math.max(0, number.getSelectionStart());
        int end = Math.max(start, number.getSelectionEnd());
        number.getText().replace(start, end, digit);
    }

    private void erase() {
        int start = Math.max(0, number.getSelectionStart());
        int end = Math.max(start, number.getSelectionEnd());
        if (start != end) number.getText().delete(start, end);
        else if (start > 0) number.getText().delete(start - 1, start);
    }

    private static String normalize(String supplied) {
        String value = supplied.replaceAll("[\\s().-]", "");
        if (value.length() > LIMIT || !value.matches("\\+?[0-9*#][0-9*#,;]*")) return null;
        return value;
    }

    // This activity exists only in the pilot manifest, which declares CALL_PHONE.
    // Stable builds compile the class without registering it or that permission.
    // The runtime grant check and SecurityException handler below remain required.
    @android.annotation.SuppressLint("MissingPermission")
    private void placeCall() {
        String value = normalize(number.getText().toString());
        if (value == null) { message("შეიყვანეთ ტელეფონის ნომერი"); return; }
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CALL_PHONE}, CALL_PERMISSION);
            return;
        }
        TelecomManager telecom = getSystemService(TelecomManager.class);
        if (telecom == null) { message("ტელეფონის სერვისი მიუწვდომელია"); return; }
        try {
            // placeCall preserves Android's emergency-call handling, SIM choice
            // and ordinary cellular call routing. Never use ACTION_CALL here.
            telecom.placeCall(Uri.fromParts("tel", value, null), new Bundle());
            callButton.setEnabled(false);
            callButton.postDelayed(() -> { if (!isFinishing()) callButton.setEnabled(true); }, 1_500);
        } catch (SecurityException permissionDenied) {
            message("დაუშვით დარეკვის ნებართვა აპის პარამეტრებში");
        } catch (RuntimeException unavailable) {
            message("ზარი ვერ დაიწყო — შეამოწმეთ SIM და ტელეფონის კავშირი");
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants);
        if (requestCode != CALL_PERMISSION) return;
        boolean granted = checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED;
        message(granted ? "ნებართვა ჩართულია — დასარეკად დააჭირეთ „დარეკვა“" : "დარეკვისთვის საჭიროა ტელეფონის ნებართვა");
        // Deliberately require another explicit press; granting a permission is
        // not a request to dial a previously supplied number.
    }

    private Button button(String label, boolean primary, Runnable action) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextSize(18);
        view.setTextColor(primary ? Color.WHITE : INK);
        view.setMinHeight(dp(56));
        view.setPadding(dp(8), dp(10), dp(8), dp(10));
        view.setBackground(background(primary ? GREEN : Color.WHITE, primary ? GREEN : Color.rgb(177, 205, 189)));
        view.setOnClickListener(ignored -> action.run());
        return view;
    }

    private GradientDrawable background(int fill, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(12));
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(INK);
        return view;
    }

    private void add(LinearLayout parent, View child, int margin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(margin);
        parent.addView(child, params);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void message(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }
}
