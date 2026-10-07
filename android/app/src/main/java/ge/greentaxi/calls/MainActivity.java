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
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 40;
    private static final int GREEN = Color.rgb(0, 153, 82);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService connectionWorker = Executors.newSingleThreadExecutor();
    private AppSettings settings;
    private CallQueue queue;
    private EditText serverInput;
    private EditText tokenInput;
    private TextView statusView;
    private TextView permissionsView;
    private TextView queueView;
    private TextView connectionView;
    private Button connectionButton;
    private volatile HttpURLConnection checkingConnection;
    private volatile boolean destroyed;
    private int connectionGeneration;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            refreshStatus();
            handler.postDelayed(this, 2_000);
        }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        settings = new AppSettings(this);
        queue = new CallQueue(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(242, 247, 244));
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(24);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                content.setPadding(padding + bars.left, padding + bars.top, padding + bars.right, padding + bars.bottom);
                return insets;
            });
        }

        TextView brand = text("Green Taxi", 32);
        brand.setTextColor(GREEN);
        brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        add(content, brand, 0);
        add(content, text("ზარებიდან განაცხადების დამატება", 20), 8);
        add(content, text("მხოლოდ მიღებული შემომავალი SIM-ზარები დაემატება ოპერატორის შემოსულ განაცხადებს. საუბარი არ იწერება. მგზავრობის დეტალებს ოპერატორი შეავსებს.", 15), 12);
        add(content, text("ჩვეულებრივი შემომავალი ზარის განაცხადი ემატება პასუხისას. გაურკვეველ შემთხვევებში ვამოწმებთ ჟურნალს საუბრის დასრულების შემდეგ.", 14), 8);

        add(content, text("ტელეფონის დაკავშირება", 18), 28);
        serverInput = input("საიტის მისამართი — https://…", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setText(settings.server());
        add(content, serverInput, 8);
        tokenInput = input("დაკავშირების კოდი ადმინისტრატორის პანელიდან", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        add(content, tokenInput, 8);
        add(content, button("დაკავშირება", this::pair), 8);
        connectionButton = button("კავშირის შემოწმება", this::checkConnection);
        add(content, connectionButton, 8);
        connectionView = text("კავშირი ჯერ არ შემოწმებულა", 14);
        add(content, connectionView, 8);

        add(content, text("წვდომა და მუშაობა", 18), 28);
        permissionsView = text("", 14);
        add(content, permissionsView, 8);
        add(content, button("ნებართვების შემოწმება", this::requestPermissions), 8);
        add(content, button("მონიტორინგის ჩართვა", this::startMonitoring), 8);
        add(content, button("მონიტორინგის შეჩერება", this::stopMonitoring), 8);

        statusView = text("", 16);
        statusView.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        add(content, statusView, 24);
        queueView = text("", 14);
        add(content, queueView, 8);
        add(content, text("ჩართვისას ძველი ზარები არ შემოდის. ინტერნეტის გარეშე ახალი ზარები ტელეფონში ინახება და კავშირის დაბრუნებისას იგზავნება.", 14), 12);
        add(content, text("Redmi-ზე შეამოწმეთ ფონური მუშაობა და ავტომატური გაშვება. ტელეფონის შეზღუდვებმა შეიძლება გაგზავნა შეაფერხოს.", 14), 16);
        add(content, button("აპის პარამეტრების გახსნა", () -> openSettings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getPackageName())))), 8);
        add(content, button("ბატარეის პარამეტრები", () -> openSettings(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))), 8);
        setContentView(scroll);
    }

    private TextView text(String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(Color.rgb(24, 52, 40));
        view.setLineSpacing(dp(3), 1.05f);
        return view;
    }

    private EditText input(String hint, int type) {
        EditText view = new EditText(this);
        view.setHint(hint);
        view.setSingleLine(true);
        view.setInputType(type);
        view.setTextSize(15);
        view.setPadding(dp(12), dp(12), dp(12), dp(12));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.WHITE);
        background.setCornerRadius(dp(10));
        background.setStroke(dp(1), Color.rgb(205, 220, 211));
        view.setBackground(background);
        view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        return view;
    }

    private Button button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setTextSize(15);
        GradientDrawable background = new GradientDrawable();
        background.setColor(GREEN);
        background.setCornerRadius(dp(10));
        button.setBackground(background);
        button.setMinHeight(dp(48));
        button.setPadding(dp(12), dp(10), dp(12), dp(10));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private void add(LinearLayout parent, View child, int marginTop) {
        LinearLayout.LayoutParams parameters = new LinearLayout.LayoutParams(-1, -2);
        parameters.topMargin = dp(marginTop);
        parent.addView(child, parameters);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void message(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }

    private void pair() {
        try {
            String raw = serverInput.getText().toString().trim();
            URI uri = new URI(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/"))) {
                message("შეიყვანეთ საიტის მთავარი HTTPS მისამართი, მაგალითად https://example.ge");
                return;
            }
            while (raw.endsWith("/")) raw = raw.substring(0, raw.length() - 1);
            String token = tokenInput.getText().toString().trim();
            if (!token.isEmpty() && !token.matches("^gtdevice_[a-f0-9]{64}$")) {
                message("დაკავშირების კოდი არასწორია");
                return;
            }
            if (token.isEmpty() && (!settings.hasToken() || !raw.equals(settings.server()))) {
                message("შეიყვანეთ ადმინისტრატორის პანელში შექმნილი დაკავშირების კოდი");
                return;
            }
            settings.pair(raw, token);
            tokenInput.setText("");
            connectionGeneration++;
            connectionButton.setEnabled(true);
            connectionView.setText("დაკავშირების მონაცემები შენახულია; შეამოწმეთ კავშირი");
            settings.status("დაკავშირების მონაცემები შენახულია; შეამოწმეთ კავშირი");
            if (settings.enabled()) startMonitoring();
            refreshStatus();
            message("დაკავშირების მონაცემები შენახულია");
        } catch (Exception invalid) {
            message("დაკავშირება ვერ შეინახა; შეამოწმეთ მისამართი და კოდი");
        }
    }

    private void checkConnection() {
        final AppSettings.Binding binding = settings.binding();
        final String server = binding.server;
        final String token;
        try {
            if (!settings.hasToken() || !validServer(server)) {
                connectionView.setText("ჯერ შეინახეთ საიტის მისამართი და დაკავშირების კოდი");
                return;
            }
            token = binding.token();
            if (!token.matches("^gtdevice_[a-f0-9]{64}$")) throw new IllegalStateException("token_unavailable");
        } catch (Exception unavailable) {
            connectionView.setText("დაკავშირების კოდი მიუწვდომელია — ხელახლა შეინახეთ კოდი");
            return;
        }
        final int generation = ++connectionGeneration;
        connectionButton.setEnabled(false);
        connectionView.setText("სერვერთან კავშირი მოწმდება…");
        connectionWorker.execute(() -> {
            String result;
            HttpURLConnection active = null;
            try {
                URL endpoint = new URL(server + "/api/integrations/android/connection");
                if (!"https".equalsIgnoreCase(endpoint.getProtocol())) throw new IllegalStateException("https_required");
                active = (HttpURLConnection) endpoint.openConnection();
                checkingConnection = active;
                active.setInstanceFollowRedirects(false);
                active.setConnectTimeout(10_000);
                active.setReadTimeout(15_000);
                active.setRequestMethod("GET");
                active.setRequestProperty("Authorization", "Bearer " + token);
                active.setRequestProperty("Accept", "application/json");
                int responseCode = active.getResponseCode();
                if (responseCode == 200) {
                    JSONObject response = new JSONObject(readConnectionResponse(active.getInputStream()));
                    JSONObject device = response.optJSONObject("device");
                    if (!Boolean.TRUE.equals(response.opt("connected")) || device == null
                            || device.optString("id", "").isEmpty()) throw new IllegalStateException("response_invalid");
                    result = "სერვერთან კავშირი დადასტურებულია";
                } else if (responseCode == 401) {
                    result = "კოდი არასწორია ან გაუქმებულია — ხელახლა დააკავშირეთ ტელეფონი";
                } else {
                    result = "სერვერთან კავშირი ვერ დადასტურდა (" + responseCode + ")";
                }
            } catch (Exception unavailable) {
                result = "კავშირი ვერ შემოწმდა — შეამოწმეთ ინტერნეტი და საიტის მისამართი";
            } finally {
                checkingConnection = null;
                if (active != null) active.disconnect();
            }
            final String displayedResult = result;
            handler.post(() -> {
                if (destroyed || generation != connectionGeneration) return;
                connectionView.setText(settings.bindingCurrent(binding) ? displayedResult
                        : "კავშირის მონაცემები შეიცვალა — ხელახლა შეამოწმეთ კავშირი");
                connectionButton.setEnabled(true);
            });
        });
    }

    private static String readConnectionResponse(InputStream source) throws Exception {
        try (InputStream input = source; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 16_384) throw new IllegalStateException("response_too_large");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static boolean validServer(String server) {
        try {
            URI uri = new URI(server);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
                    && uri.getUserInfo() == null && uri.getQuery() == null && uri.getFragment() == null
                    && (uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"));
        } catch (Exception invalid) {
            return false;
        }
    }

    private void requestPermissions() {
        List<String> missing = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.READ_CALL_LOG);
        if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.READ_PHONE_STATE);
        if (checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.READ_PHONE_NUMBERS);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.POST_NOTIFICATIONS);
        if (missing.isEmpty()) {
            message(CallMonitorService.notificationsEnabled(this) ? "ნებართვები ჩართულია"
                    : "შეტყობინებები გამორთულია — შეამოწმეთ აპის პარამეტრები");
        } else {
            requestPermissions(missing.toArray(new String[0]), PERMISSION_REQUEST);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        refreshStatus();
        if (requestCode == PERMISSION_REQUEST && !CallMonitorService.permissionsGranted(this)) {
            if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
                settings.status("ზარების ჟურნალი მიუწვდომელია. Android-ის დაყენების შეზღუდვა შეიძლება დამატებით შემოწმებას საჭიროებდეს");
                message("Android-მა ზარების წვდომა არ გასცა. შეამოწმეთ აპის ნებართვები და დაყენების პირობები");
            } else {
                settings.status("SIM-ანგარიშის ამოსაცნობად ჩართეთ ტელეფონის ნებართვები");
                message("SIM-ის ამოსაცნობად საჭიროა ტელეფონის ორივე ნებართვა");
            }
            refreshStatus();
        }
    }

    private void startMonitoring() {
        if (!settings.hasToken() || !validServer(settings.server())) {
            message("ჯერ დააკავშირეთ ტელეფონი");
            return;
        }
        if (!CallMonitorService.permissionsGranted(this)) {
            requestPermissions();
            message("მონიტორინგისთვის საჭიროა ზარებისა და SIM-ის წვდომა");
            return;
        }
        if (!CallMonitorService.notificationsEnabled(this)) {
            requestPermissions();
            message("მონიტორინგის შეტყობინებისთვის ჩართეთ შეტყობინებების ნებართვა");
            return;
        }
        try {
            if (!settings.token().matches("^gtdevice_[a-f0-9]{64}$")) throw new IllegalStateException("token_unavailable");
            settings.beginMonitoring();
            startForegroundService(new Intent(this, CallMonitorService.class));
        } catch (Exception unavailable) {
            settings.status("მონიტორინგი ვერ ჩაირთო — შეამოწმეთ დაკავშირება და აპის პარამეტრები");
        }
        refreshStatus();
    }

    private void resumeMonitoring() {
        if (!settings.enabled() || CallMonitorService.isRunning() || !settings.hasToken()
                || !validServer(settings.server()) || !CallMonitorService.permissionsGranted(this)
                || !CallMonitorService.notificationsEnabled(this)) return;
        try {
            if (!settings.token().matches("^gtdevice_[a-f0-9]{64}$")) throw new IllegalStateException("token_unavailable");
            // Resume an existing opt-in without changing its baseline, watermark, or queued calls.
            startForegroundService(new Intent(this, CallMonitorService.class));
        } catch (Exception unavailable) {
            settings.status("მონიტორინგი ვერ განახლდა — შეამოწმეთ აპის პარამეტრები");
        }
    }

    private void stopMonitoring() {
        settings.disable();
        stopService(new Intent(this, CallMonitorService.class));
        settings.status("მონიტორინგი შეჩერებულია; გაუგზავნელი ზარები შენახულია");
        refreshStatus();
    }

    private void refreshStatus() {
        if (statusView == null) return;
        String access = "ზარების ჟურნალი: " + (checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED ? "ჩართულია" : "მიუწვდომელია");
        access += "\nSIM-ის წვდომა: " + (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED ? "ჩართულია" : "მიუწვდომელია");
        access += "\nSIM-ანგარიშის წვდომა: " + (checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED ? "ჩართულია" : "მიუწვდომელია");
        access += "\nშეტყობინებები: " + (CallMonitorService.notificationsEnabled(this) ? "ჩართულია" : "გამორთულია");
        permissionsView.setText(access);
        statusView.setText(settings.enabled() && !CallMonitorService.isRunning()
                ? "მონიტორინგი ამჟამად არ მუშაობს; შეამოწმეთ ნებართვები და ხელახლა ჩართეთ"
                : settings.status());
        queueView.setText("გასაგზავნი ზარები: " + queue.pendingCount()
                + "\nსერვერის მიერ მიღებული ზარები: " + queue.deliveredCount());
    }

    private void openSettings(Intent intent) {
        try { startActivity(intent); } catch (RuntimeException unavailable) { message("გახსენით ტელეფონის პარამეტრები და მოძებნეთ Green Taxi"); }
    }

    @Override protected void onResume() { super.onResume(); resumeMonitoring(); handler.post(refresh); }
    @Override protected void onPause() { handler.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() {
        destroyed = true;
        connectionGeneration++;
        handler.removeCallbacksAndMessages(null);
        connectionWorker.shutdownNow();
        HttpURLConnection active = checkingConnection;
        if (active != null) active.disconnect();
        queue.close();
        super.onDestroy();
    }
}
