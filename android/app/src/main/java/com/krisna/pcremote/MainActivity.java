package com.krisna.pcremote;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(SystemBarsPlugin.class);
        super.onCreate(savedInstanceState);

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
}
