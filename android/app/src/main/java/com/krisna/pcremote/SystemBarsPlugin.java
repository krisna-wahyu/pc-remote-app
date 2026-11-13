package com.krisna.pcremote;

import android.graphics.Color;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Warna status bar & navigation bar mengikuti tema aplikasi (terang / gelap).
 * Dipanggil dari www/theme.js lewat Capacitor.registerPlugin('SystemBars').
 */
@CapacitorPlugin(name = "SystemBars")
public class SystemBarsPlugin extends Plugin {

    @PluginMethod
    public void setStyle(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", true));
        int color;
        try {
            color = Color.parseColor(call.getString("color", dark ? "#0b0b0d" : "#f6f6f8"));
        } catch (IllegalArgumentException e) {
            call.reject("Warna tidak valid");
            return;
        }
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            View decor = window.getDecorView();
            // Android 15+ (edge-to-edge) mengabaikan warna bar; area di belakangnya memakai latar jendela.
            decor.setBackgroundColor(color);
            window.setStatusBarColor(color);
            window.setNavigationBarColor(color);
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().setBackgroundColor(color);
            }
            WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(window, decor);
            ctl.setAppearanceLightStatusBars(!dark);
            ctl.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }
}
