package com.krisna.pcremote;

import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Bersihkan cache di HP saat riwayat chat dibersihkan: foto/file yang pernah dimuat WebView
 * (disimpan server dengan Cache-Control max-age) dan APK update lama di cache/updates.
 * Data aplikasi (alamat server, token terenkripsi, PIN, tema) tidak disentuh — itu di localStorage.
 * Dipanggil dari www/app.js lewat pcNative('AppCache').
 */
@CapacitorPlugin(name = "AppCache")
public class AppCachePlugin extends Plugin {

    @PluginMethod
    public void clear(PluginCall call) {
        File cacheDir = getContext().getCacheDir();
        long before = sizeOf(cacheDir);
        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null) webView.clearCache(true); // true = termasuk cache di disk
                deleteRecursive(new File(cacheDir, "updates"));
                JSObject ret = new JSObject();
                ret.put("freedBytes", Math.max(0, before - sizeOf(cacheDir)));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Gagal membersihkan cache: " + e.getMessage());
            }
        });
    }

    private static long sizeOf(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long total = 0;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) total += sizeOf(c);
        return total;
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
