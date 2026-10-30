package ge.greentaxi.driver;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

/** A dedicated, permission-light driver entry point into the same live website. */
public final class MainActivity extends Activity {
    private WebView webView;
    private LinearLayout errorPanel;
    private LinearLayout loadingPanel;
    private boolean failed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(241, 246, 242));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets padding = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        loadingPanel = makeLoadingPanel();
        root.addView(loadingPanel, new FrameLayout.LayoutParams(-1, -1));
        errorPanel = makeErrorPanel();
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        configureWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        }
        loadDriver();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " GreenTaxiDriver/1.0");
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
        webView.setBackgroundColor(Color.rgb(241, 246, 242));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !NavigationPolicy.isTrustedResource(request.getUrl().toString());
                String value = request.getUrl().toString();
                if (NavigationPolicy.isDriverPage(value)) return false;
                if (request.hasGesture()) {
                    String number = NavigationPolicy.dialNumber(value);
                    if (number != null) launchDialer(number);
                    else if (NavigationPolicy.isExternalWebPage(value)) launchBrowser(value);
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (NavigationPolicy.isTrustedResource(request.getUrl().toString())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                    java.util.Collections.emptyMap(), new ByteArrayInputStream(
                        "Unsupported resource".getBytes(StandardCharsets.UTF_8)));
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!NavigationPolicy.isDriverPage(url)) { view.stopLoading(); showError(); return; }
                failed = false;
                errorPanel.setVisibility(View.GONE);
                loadingPanel.setVisibility(View.VISIBLE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (!failed && NavigationPolicy.isDriverPage(url)) loadingPanel.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame()) showError();
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError();
            }
        });
        // Explicit links already use the gesture-checked navigation policy.
        // Web content cannot trigger downloads or automatic browser launches.
        webView.setDownloadListener((url, userAgent, disposition, mime, length) -> { });
    }

    private void loadDriver() {
        failed = false;
        errorPanel.setVisibility(View.GONE);
        loadingPanel.setVisibility(View.VISIBLE);
        webView.loadUrl(NavigationPolicy.DRIVER_URL);
    }

    private void showError() {
        failed = true;
        loadingPanel.setVisibility(View.GONE);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private LinearLayout panel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        panel.setBackgroundColor(Color.rgb(241, 246, 242));
        return panel;
    }

    private TextView text(int resource, int size) {
        TextView text = new TextView(this);
        text.setText(resource);
        text.setTextSize(size);
        text.setTextColor(Color.rgb(23, 60, 40));
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, dp(12), 0, dp(12));
        return text;
    }

    private LinearLayout makeLoadingPanel() {
        LinearLayout panel = panel();
        panel.addView(new ProgressBar(this), new LinearLayout.LayoutParams(dp(48), dp(48)));
        panel.addView(text(R.string.loading, 20));
        return panel;
    }

    private LinearLayout makeErrorPanel() {
        LinearLayout panel = panel();
        panel.addView(text(R.string.connection_title, 26));
        panel.addView(text(R.string.connection_message, 19));
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setAllCaps(false);
        retry.setTextSize(20);
        retry.setMinHeight(dp(64));
        retry.setTextColor(Color.WHITE);
        retry.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(9, 107, 59)));
        retry.setOnClickListener(view -> loadDriver());
        LinearLayout.LayoutParams button = new LinearLayout.LayoutParams(-1, dp(68));
        button.topMargin = dp(20);
        panel.addView(retry, button);
        panel.setVisibility(View.GONE);
        return panel;
    }

    private void launchDialer(String number) {
        try { startActivity(new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))); }
        catch (ActivityNotFoundException ignored) { Toast.makeText(this, R.string.dialer_unavailable, Toast.LENGTH_LONG).show(); }
    }

    private void launchBrowser(String value) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException ignored) { Toast.makeText(this, R.string.browser_unavailable, Toast.LENGTH_LONG).show(); }
    }

    private void navigateBack() {
        if (webView.canGoBack()) {
            android.webkit.WebBackForwardList history = webView.copyBackForwardList();
            android.webkit.WebHistoryItem previous = history.getItemAtIndex(history.getCurrentIndex() - 1);
            if (previous != null && NavigationPolicy.isDriverPage(previous.getUrl())) { webView.goBack(); return; }
        }
        finish();
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { navigateBack(); }
    @Override protected void onPause() { CookieManager.getInstance().flush(); webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override protected void onStop() { CookieManager.getInstance().flush(); super.onStop(); }
    @Override protected void onDestroy() {
        if (webView != null) { webView.stopLoading(); ((FrameLayout) webView.getParent()).removeView(webView); webView.destroy(); }
        super.onDestroy();
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
