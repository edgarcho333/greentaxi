package ge.greentaxi.calls;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.util.Map;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class AppSettings {
    private static final String KEY_ALIAS = "greentaxi_device_token_v1";
    private static final Object BINDING_LOCK = new Object();
    private final SharedPreferences preferences;

    static final class Binding {
        final String server;
        private final String encryptedToken;

        private Binding(String server, String encryptedToken) {
            this.server = server;
            this.encryptedToken = encryptedToken;
        }

        String token() throws Exception { return decryptToken(encryptedToken); }
    }

    AppSettings(Context context) {
        preferences = context.getSharedPreferences("greentaxi_calls", Context.MODE_PRIVATE);
    }

    synchronized String installationId() {
        String value = preferences.getString("installation_id", "");
        if (value.isEmpty()) {
            value = UUID.randomUUID().toString();
            preferences.edit().putString("installation_id", value).commit();
        }
        return value;
    }

    String server() { return preferences.getString("server", ""); }
    boolean hasToken() { return preferences.contains("encrypted_token"); }
    boolean enabled() { return preferences.getBoolean("enabled", false); }
    boolean authPaused() { return preferences.getBoolean("auth_paused", false); }
    Binding binding() {
        Map<String, ?> values = preferences.getAll();
        Object server = values.get("server");
        Object token = values.get("encrypted_token");
        return new Binding(server instanceof String ? (String) server : "",
                token instanceof String ? (String) token : "");
    }

    boolean bindingCurrent(Binding binding) {
        Binding current = binding();
        return binding.server.equals(current.server) && binding.encryptedToken.equals(current.encryptedToken);
    }

    boolean pauseAuthenticationIfCurrent(Binding binding) {
        synchronized (BINDING_LOCK) {
            if (!bindingCurrent(binding)) return false;
            preferences.edit().putBoolean("auth_paused", true).commit();
            return true;
        }
    }
    String status() { return preferences.getString("status", "მონიტორინგი შეჩერებულია"); }
    void status(String value) { preferences.edit().putString("status", value).apply(); }
    long baseline() { return preferences.getLong("baseline_ms", Long.MAX_VALUE); }
    long lastDate() { return preferences.getLong("last_date", baseline()); }
    long lastRow() { return preferences.getLong("last_row", 0); }

    void beginMonitoring() {
        if (!enabled()) {
            long now = System.currentTimeMillis();
            preferences.edit().putBoolean("enabled", true).putLong("baseline_ms", now)
                    .putLong("last_date", now).putLong("last_row", 0).commit();
        }
    }

    void disable() { preferences.edit().putBoolean("enabled", false).commit(); }

    void watermark(long row, long date) {
        preferences.edit().putLong("last_row", row).putLong("last_date", date).commit();
    }

    void pair(String server, String replacementToken) throws Exception {
        synchronized (BINDING_LOCK) {
            SharedPreferences.Editor editor = preferences.edit().putString("server", server);
            if (!replacementToken.isEmpty()) {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key());
                byte[] ciphertext = cipher.doFinal(replacementToken.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                editor.putString("encrypted_token", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                        + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP));
            }
            if (!hasToken() && replacementToken.isEmpty()) throw new IllegalArgumentException("token_required");
            if (!editor.putBoolean("auth_paused", false).commit()) {
                throw new IllegalStateException("pairing_storage_unavailable");
            }
        }
    }

    String token() throws Exception { return binding().token(); }

    private static String decryptToken(String encoded) throws Exception {
        String[] parts = encoded.split(":", 2);
        if (parts.length != 2) throw new IllegalStateException("token_unavailable");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        byte[] decrypted = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
        return new String(decrypted, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
