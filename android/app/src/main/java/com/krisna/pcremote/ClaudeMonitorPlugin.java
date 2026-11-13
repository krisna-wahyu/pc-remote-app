package com.krisna.pcremote;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Jembatan www/app.js → ClaudeMonitorService (notifikasi progres Claude saat aplikasi ditinggal).
 * start({ server, token, since, project, prompt }) dipanggil saat prompt dikirim di dev mode.
 */
@CapacitorPlugin(
    name = "ClaudeMonitor",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class ClaudeMonitorPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Android 13+: minta izin notifikasi sekali. Ditolak pun layanan tetap jalan (notifikasi tidak tampil).
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) { doStart(call); }

    private void doStart(PluginCall call) {
        String server = call.getString("server", "");
        String token = call.getString("token", "");
        if (server.isEmpty() || token.isEmpty()) {
            call.reject("server/token kosong");
            return;
        }
        Intent i = new Intent(getContext(), ClaudeMonitorService.class)
            .setAction(ClaudeMonitorService.ACTION_START)
            .putExtra("server", server)
            .putExtra("token", token)
            .putExtra("since", call.getLong("since", 0L))
            .putExtra("project", call.getString("project", ""))
            .putExtra("prompt", call.getString("prompt", ""));
        try {
            ContextCompat.startForegroundService(getContext(), i);
            JSObject ret = new JSObject();
            ret.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Gagal memulai pemantau: " + e.getMessage());
        }
    }

    /** Token diganti di aplikasi → pemantau yang sedang jalan memakai token baru. */
    @PluginMethod
    public void updateToken(PluginCall call) {
        if (ClaudeMonitorService.running) {
            Intent i = new Intent(getContext(), ClaudeMonitorService.class)
                .setAction(ClaudeMonitorService.ACTION_UPDATE)
                .putExtra("token", call.getString("token", ""));
            getContext().startService(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (ClaudeMonitorService.running) {
            getContext().startService(new Intent(getContext(), ClaudeMonitorService.class).setAction(ClaudeMonitorService.ACTION_STOP));
        }
        call.resolve();
    }
}
