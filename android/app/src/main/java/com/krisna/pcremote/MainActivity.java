package com.krisna.pcremote;

import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(SystemBarsPlugin.class);
        super.onCreate(savedInstanceState);
        fitWebViewAboveKeyboard();

        // Tombol Back Android: tanya dulu ke aplikasi web (www/app.js → window.pcHandleBack) apakah ada
        // lapisan yang bisa ditutup (foto, Pengaturan, tab Aktivitas) — seperti navigate(-1).
        // Tanpa ini Back langsung menutup aplikasi, karena plugin @capacitor/app tidak dipakai.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    systemBack();
                    return;
                }
                webView.evaluateJavascript(
                    "(function(){try{return !!(window.pcHandleBack&&window.pcHandleBack());}catch(e){return false;}})()",
                    result -> {
                        if (!"true".equals(result)) systemBack();
                    }
                );
            }

            private void systemBack() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    /**
     * Capacitor (adjustMarginsForEdgeToEdge=force) hanya memberi margin untuk status/navigation bar, tidak untuk
     * keyboard, dan di Android 15 adjustResize tidak lagi mengecilkan layar. Akibatnya kotak ketik tertutup keyboard.
     * Listener Capacitor diganti: margin bawah = tinggi keyboard bila terbuka, selain itu tinggi navigation bar.
     */
    private void fitWebViewAboveKeyboard() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = bars.left;
            mlp.topMargin = bars.top;
            mlp.rightMargin = bars.right;
            mlp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
    }
}
