package com.krisna.pcremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Buka PC Remote dengan sidik jari (dialog bawaan HP). PIN tetap kunci utama:
 * PIN dienkripsi dengan kunci Android Keystore yang hanya bisa dipakai setelah sidik jari terverifikasi
 * (BIOMETRIC_STRONG). Sidik jari baru didaftarkan di HP → kunci hangus → harus PIN lalu aktifkan lagi.
 * Dipakai dari www/app.js lewat pcNative('Biometric').
 */
@CapacitorPlugin(name = "Biometric")
public class BiometricPlugin extends Plugin {

    private static final String KEY_ALIAS = "pcremote_bio_pin";
    private static final String PREFS = "pcremote_bio";
    private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private interface OnAuth { void run(BiometricPrompt.AuthenticationResult r) throws Exception; }

    /** { status: available | none_enrolled | unavailable, enabled } */
    @PluginMethod
    public void status(PluginCall call) {
        int can = BiometricManager.from(getContext()).canAuthenticate(AUTH);
        String status = can == BiometricManager.BIOMETRIC_SUCCESS ? "available"
            : can == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ? "none_enrolled" : "unavailable";
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("enabled", isEnabled());
        call.resolve(ret);
    }

    /** Simpan { secret } (PIN) terenkripsi; minta sidik jari sekali untuk konfirmasi. */
    @PluginMethod
    public void enable(PluginCall call) {
        String secret = call.getString("secret", "");
        if (secret.isEmpty()) { call.reject("PIN kosong", "error"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                deleteAll();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, createKey());
                prompt(call, cipher, "Aktifkan sidik jari", "Sentuh sensor untuk membuka PC Remote dengan sidik jari", r -> {
                    Cipher c = r.getCryptoObject().getCipher();
                    byte[] ct = c.doFinal(secret.getBytes(StandardCharsets.UTF_8));
                    prefs().edit()
                        .putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                        .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                        .apply();
                    call.resolve();
                });
            } catch (Exception e) {
                deleteAll();
                call.reject("Gagal mengaktifkan sidik jari: " + e.getMessage(), "error");
            }
        });
    }

    /** Minta sidik jari → { secret } (PIN). */
    @PluginMethod
    public void unlock(PluginCall call) {
        String ct = prefs().getString("ct", null);
        String iv = prefs().getString("iv", null);
        if (ct == null || iv == null) { call.reject("Sidik jari belum diaktifkan", "not_enabled"); return; }
        getActivity().runOnUiThread(() -> {
            Cipher cipher;
            try {
                SecretKey key = (SecretKey) keyStore().getKey(KEY_ALIAS, null);
                if (key == null) throw new KeyPermanentlyInvalidatedException();
                cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            } catch (KeyPermanentlyInvalidatedException e) {
                deleteAll();
                call.reject("Sidik jari di HP berubah. Masukkan PIN, lalu aktifkan lagi di Pengaturan.", "invalidated");
                return;
            } catch (Exception e) {
                call.reject("Sidik jari tidak bisa dipakai: " + e.getMessage(), "error");
                return;
            }
            prompt(call, cipher, "Buka PC Remote", "Gunakan sidik jari", r -> {
                byte[] plain = r.getCryptoObject().getCipher().doFinal(Base64.decode(ct, Base64.NO_WRAP));
                JSObject ret = new JSObject();
                ret.put("secret", new String(plain, StandardCharsets.UTF_8));
                call.resolve(ret);
            });
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        deleteAll();
        call.resolve();
    }

    // ------------------------------------------------------------------------------------------

    private void prompt(PluginCall call, Cipher cipher, String title, String subtitle, OnAuth onSuccess) {
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setNegativeButtonText("Pakai PIN")
            .setAllowedAuthenticators(AUTH)
            .build();
        BiometricPrompt bp = new BiometricPrompt((FragmentActivity) getActivity(), ContextCompat.getMainExecutor(getContext()),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    try {
                        onSuccess.run(result);
                    } catch (Exception e) {
                        call.reject("Sidik jari gagal diproses: " + e.getMessage(), "error");
                    }
                }

                @Override
                public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                    String c = code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_USER_CANCELED
                        || code == BiometricPrompt.ERROR_CANCELED ? "cancelled"
                        : code == BiometricPrompt.ERROR_LOCKOUT || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT ? "lockout"
                        : "error";
                    call.reject(msg.toString(), c);
                }
                // onAuthenticationFailed (jari tidak cocok): dialog HP sendiri menampilkan "coba lagi".
            });
        bp.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
    }

    private SecretKey createKey() throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= 24) b.setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(b.build());
        return kg.generateKey();
    }

    private boolean isEnabled() {
        try {
            return prefs().contains("ct") && keyStore().containsAlias(KEY_ALIAS);
        } catch (Exception e) {
            return false;
        }
    }

    private void deleteAll() {
        prefs().edit().clear().apply();
        try { keyStore().deleteEntry(KEY_ALIAS); } catch (Exception ignored) { /* tidak ada */ }
    }

    private KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
