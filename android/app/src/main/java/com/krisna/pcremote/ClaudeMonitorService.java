package com.krisna.pcremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.text.Html;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Memantau sesi Claude Code (dev mode) saat aplikasi ditinggal, lewat sambungan SSE sendiri ke pc-remote-bot.
 * Satu notifikasi berjalan yang terus diperbarui (senyap): "Terkirim" → "Claude bekerja" + langkah terbaru.
 * Selesai → notifikasi ringkasan (bunyi sekali). Butuh izin / pertanyaan → satu notifikasi (bunyi sekali).
 * Berhenti sendiri saat semua sesi selesai. Token hanya disimpan di memori.
 */
public class ClaudeMonitorService extends Service {

    static final String ACTION_START = "com.krisna.pcremote.MONITOR_START";
    static final String ACTION_UPDATE = "com.krisna.pcremote.MONITOR_UPDATE";
    static final String ACTION_STOP = "com.krisna.pcremote.MONITOR_STOP";
    static final String EXTRA_OPEN_CHAT = "openChat";

    private static final String CH_PROGRESS = "claude_progress";
    private static final String CH_ALERT = "claude_alert";
    private static final int ONGOING_ID = 7001;
    private static final int ACTION_ID = 7002;
    private static final int SUMMARY_BASE_ID = 7100;

    private static final long NO_SESSION_LIMIT_MS = 3 * 60 * 1000;   // prompt tidak pernah "terkirim"
    private static final long IDLE_LIMIT_MS = 75 * 60 * 1000;        // bot berhenti memantau setelah 60 menit
    private static final long SUMMARY_WAIT_MS = 15 * 1000;           // jeda antara "selesai" dan ringkasan

    private static final String SENT_PREFIX = "✅ Terkirim ke Claude Code";
    private static final String SUMMARY_PREFIX = "📝 Ringkasan Claude";
    // Baris pertama pesan proses dari devmode.js reportTurn: "<ikon> <judul> — <project> · <durasi>"
    private static final Pattern PROGRESS = Pattern.compile(
        "^(\\S+)\\s+(Claude bekerja|Antre[^—]*?|Claude selesai|Dihentikan|Berlanjut ke prompt berikutnya|"
            + "Berhenti memantau[^—]*?|Prompt tidak ditemukan[^—]*?)\\s+—\\s+(.+?)\\s+·\\s+(\\S.*)$");

    static volatile boolean running = false;

    private static class Session {
        long sentId;
        long progressId = -1;
        String project = "";
        String prompt = "";
        String title = "";
        String detail = "";
        String endLine = "";
        boolean ended;
        boolean done;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final LinkedHashMap<Long, Session> sessions = new LinkedHashMap<>();
    private volatile String server = "";
    private volatile String token = "";
    private volatile long seq = 0;
    private volatile boolean stopped = false;
    private volatile HttpURLConnection current;
    private Thread worker;
    private long startedAt;
    private long lastActivity;
    private String pendingProject = "";
    private String pendingPrompt = "";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel progress = new NotificationChannel(CH_PROGRESS, "Progres Claude", NotificationManager.IMPORTANCE_LOW);
            progress.setDescription("Status Claude Code yang sedang bekerja (senyap, terus diperbarui)");
            progress.setShowBadge(false);
            NotificationChannel alert = new NotificationChannel(CH_ALERT, "Claude selesai / butuh tindakan", NotificationManager.IMPORTANCE_HIGH);
            alert.setDescription("Ringkasan saat Claude selesai, atau saat Claude butuh izin / bertanya");
            nm.createNotificationChannel(progress);
            nm.createNotificationChannel(alert);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null || ACTION_STOP.equals(action)) {
            stopAll();
            return START_NOT_STICKY;
        }
        if (ACTION_UPDATE.equals(action)) {
            if (intent.hasExtra("token")) token = intent.getStringExtra("token");
            closeCurrent(); // sambung ulang dengan token baru
            return START_NOT_STICKY;
        }

        server = trimSlash(intent.getStringExtra("server"));
        token = nz(intent.getStringExtra("token"));
        long since = intent.getLongExtra("since", 0);
        if (!running) seq = since;
        pendingProject = nz(intent.getStringExtra("project"));
        pendingPrompt = nz(intent.getStringExtra("prompt"));
        long now = System.currentTimeMillis();
        if (!running) startedAt = now;
        lastActivity = now;

        Session cur = currentSession();
        Notification n = cur != null ? ongoing(cur) : ongoingWaiting();
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
        ServiceCompat.startForeground(this, ONGOING_ID, n, type);
        running = true;

        if (worker == null || !worker.isAlive()) {
            stopped = false;
            worker = new Thread(this::loop, "claude-monitor");
            worker.start();
            main.postDelayed(this::watchdog, 60 * 1000);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) { stopAll(); } // Android 15: batas waktu dataSync

    @Override
    public void onDestroy() {
        stopped = true;
        running = false;
        closeCurrent();
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    // ---------------------------------------------------------------- jaringan

    private void loop() {
        long backoff = 2000;
        while (!stopped) {
            try {
                catchUp();
                stream();
                backoff = 2000;
            } catch (AuthException e) {
                main.post(this::stopAll); // token diganti / dicabut
                return;
            } catch (Exception ignored) {
                // putus / timeout → sambung ulang
            }
            if (stopped) return;
            try { Thread.sleep(backoff); } catch (InterruptedException e) { return; }
            backoff = Math.min(backoff * 2, 30000);
        }
    }

    private static class AuthException extends Exception {}

    private HttpURLConnection open(String path, int readTimeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(server + path).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(readTimeout);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", path.startsWith("/api/events") ? "text/event-stream" : "application/json");
        int code = c.getResponseCode();
        if (code == 401) { c.disconnect(); throw new AuthException(); }
        if (code != 200) { c.disconnect(); throw new Exception("HTTP " + code); }
        return c;
    }

    // Pesan yang terlewat (mis. "Terkirim" datang sebelum sambungan siap, atau saat sambungan putus).
    private void catchUp() throws Exception {
        long since = seq;
        HttpURLConnection c = open("/api/messages?since=" + since, 20000);
        String body;
        try (InputStream in = c.getInputStream()) {
            body = new String(readAll(in), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
        JSONObject r = new JSONObject(body);
        JSONArray list = r.optJSONArray("messages");
        if (since > 0 && list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject m = list.optJSONObject(i);
                if (m != null && m.optLong("rev") > since) post(m);
            }
        }
        seq = Math.max(seq, r.optLong("seq", seq));
    }

    private void stream() throws Exception {
        HttpURLConnection c = open("/api/events", 70000); // server mengirim ping tiap 20 detik
        current = c;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String event = "";
            StringBuilder data = new StringBuilder();
            String line;
            while (!stopped && (line = br.readLine()) != null) {
                if (line.startsWith("event:")) event = line.substring(6).trim();
                else if (line.startsWith("data:")) data.append(line.substring(5).trim());
                else if (line.isEmpty()) {
                    dispatch(event, data.toString());
                    event = "";
                    data.setLength(0);
                }
            }
        } finally {
            current = null;
            c.disconnect();
        }
    }

    private void dispatch(String event, String data) throws Exception {
        if ("change".equals(event)) {
            JSONObject m = new JSONObject(data);
            long rev = m.optLong("rev");
            if (rev <= seq) return;
            seq = rev;
            post(m);
        } else if ("hello".equals(event)) {
            long s = new JSONObject(data).optLong("seq");
            if (s > seq) catchUp(); // ada perubahan di antara catchUp dan sambungan SSE
        }
    }

    private void post(JSONObject m) { main.post(() -> handle(m)); }

    private void closeCurrent() {
        HttpURLConnection c = current;
        if (c != null) new Thread(c::disconnect).start(); // memutus readLine() yang sedang menunggu
    }

    // ---------------------------------------------------------------- sesi (main thread)

    private void handle(JSONObject m) {
        if (stopped || "me".equals(m.optString("from")) || m.optBoolean("deleted")) return;
        String html = m.optString("text", "");
        if (html.isEmpty()) return;
        String plain = toPlain(html);
        String first = plain.split("\n", 2)[0].trim();
        long id = m.optLong("id");

        if (first.startsWith(SENT_PREFIX)) {
            if (sessions.containsKey(id)) return;
            Session s = new Session();
            s.sentId = id;
            s.project = first.substring(SENT_PREFIX.length()).trim();
            String[] lines = plain.split("\n");
            s.prompt = lines.length > 1 ? lines[1].trim() : "";
            s.title = "📨 Terkirim ke Claude";
            s.detail = s.prompt;
            sessions.put(id, s);
            touch();
            refreshOngoing();
            return;
        }

        Matcher pm = PROGRESS.matcher(first);
        if (pm.find()) {
            Session s = byProgress(id);
            if (s == null) {
                s = oldestWithoutProgress();
                if (s == null) return;
                s.progressId = id;
            }
            String title = pm.group(2);
            String duration = pm.group(4);
            boolean ending = !title.startsWith("Claude bekerja") && !title.startsWith("Antre");
            touch();
            if (!ending) {
                s.title = title.startsWith("Antre") ? "⏳ Antre di belakang prompt sebelumnya" : "🤖 Claude bekerja · " + duration;
                s.detail = lastStep(plain, s.prompt);
                cancel(ACTION_ID); // izin / pertanyaan sudah dijawab, Claude lanjut
                refreshOngoing();
            } else if (!s.ended) {
                s.ended = true;
                s.endLine = pm.group(1) + " " + title + " · " + duration;
                s.title = s.endLine;
                s.detail = "Menyiapkan ringkasan…";
                cancel(ACTION_ID);
                refreshOngoing();
                final Session ended = s;
                main.postDelayed(() -> { if (!ended.done) finish(ended, ""); }, SUMMARY_WAIT_MS);
            }
            return;
        }

        if (first.startsWith(SUMMARY_PREFIX)) {
            Session s = latestEnded();
            if (s == null) s = latestActive();
            if (s == null || s.done) return;
            int nl = plain.indexOf('\n');
            finish(s, nl >= 0 ? plain.substring(nl + 1).trim() : "");
            return;
        }

        if (first.startsWith("⏸ Claude menunggu") || first.startsWith("❓ Claude bertanya")) {
            Session s = latestActive();
            if (s == null) return;
            touch();
            boolean question = first.startsWith("❓");
            int nl = plain.indexOf('\n');
            String body = nl >= 0 ? plain.substring(nl + 1).trim() : "";
            notify(ACTION_ID, alert(question ? "❓ Claude bertanya — " + s.project : "⏸ Claude butuh izin — " + s.project,
                body.isEmpty() ? "Buka aplikasi untuk menjawab." : body, null));
        }
    }

    private void finish(Session s, String summary) {
        if (s.done) return;
        s.done = true;
        String title = (s.endLine.isEmpty() ? "✅ Claude selesai" : s.endLine.replaceAll("\\s+·\\s+\\S.*$", "")) + " — " + s.project;
        String sub = s.endLine.contains("·") ? s.endLine.substring(s.endLine.indexOf('·') + 1).trim() : null;
        String body = summary.isEmpty() ? (s.prompt.isEmpty() ? "Tidak ada ringkasan." : "Prompt: " + s.prompt) : summary;
        notify(SUMMARY_BASE_ID + (int) (s.sentId % 800), alert(title, body, sub));
        cancel(ACTION_ID);
        touch();
        if (latestActive() == null) stopAll();
        else refreshOngoing();
    }

    private void refreshOngoing() {
        Session s = currentSession();
        notify(ONGOING_ID, s != null ? ongoing(s) : ongoingWaiting());
    }

    // Yang paling relevan: sesi yang sedang dikerjakan, kalau tidak ada → sesi terbaru yang belum selesai.
    private Session currentSession() {
        for (Session s : sessions.values()) if (!s.done && s.progressId >= 0 && !s.ended) return s;
        return latestActive();
    }

    private Session latestActive() {
        Session last = null;
        for (Session s : sessions.values()) if (!s.done) last = s;
        return last;
    }

    private Session latestEnded() {
        Session last = null;
        for (Session s : sessions.values()) if (!s.done && s.ended) last = s;
        return last;
    }

    private Session byProgress(long id) {
        for (Session s : sessions.values()) if (s.progressId == id) return s;
        return null;
    }

    private Session oldestWithoutProgress() {
        for (Session s : sessions.values()) if (!s.done && s.progressId < 0) return s;
        return null;
    }

    private int activeCount() {
        int n = 0;
        for (Session s : sessions.values()) if (!s.done) n++;
        return n;
    }

    private void touch() { lastActivity = System.currentTimeMillis(); }

    private void watchdog() {
        if (stopped) return;
        long now = System.currentTimeMillis();
        boolean noSession = sessions.isEmpty() && now - startedAt > NO_SESSION_LIMIT_MS;
        if (noSession || now - lastActivity > IDLE_LIMIT_MS) { stopAll(); return; }
        main.postDelayed(this::watchdog, 60 * 1000);
    }

    private void stopAll() {
        stopped = true;
        running = false;
        closeCurrent();
        main.removeCallbacksAndMessages(null);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    // ---------------------------------------------------------------- notifikasi

    private PendingIntent openChat() {
        Intent i = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN_CHAT, true);
        return PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification ongoingWaiting() {
        String title = "📨 Mengirim ke Claude" + (pendingProject.isEmpty() ? "" : " — " + pendingProject);
        return base(CH_PROGRESS, title, pendingPrompt.isEmpty() ? "Menunggu konfirmasi dari PC…" : pendingPrompt)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW).build();
    }

    private Notification ongoing(Session s) {
        int active = activeCount();
        String sub = s.project + (active > 1 ? " · " + active + " prompt" : "");
        return base(CH_PROGRESS, s.title, s.detail.isEmpty() ? s.prompt : s.detail)
            .setSubText(sub)
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW).build();
    }

    private Notification alert(String title, String body, String sub) {
        NotificationCompat.Builder b = base(CH_ALERT, title, body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE);
        if (sub != null) b.setSubText(sub);
        return b.build();
    }

    private NotificationCompat.Builder base(String channel, String title, String body) {
        String text = body.length() > 3500 ? body.substring(0, 3500) + "…" : body;
        return new NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(firstLine(text))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openChat())
            .setColor(0xFFE11D2E)
            .setShowWhen(true);
    }

    private void notify(int id, Notification n) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        try { nm.notify(id, n); } catch (SecurityException ignored) { /* izin notifikasi ditolak */ }
    }

    private void cancel(int id) {
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(id);
    }

    // ---------------------------------------------------------------- teks

    // HTML Telegram (baris baru = "\n") → teks biasa dengan baris baru.
    @SuppressWarnings("deprecation")
    private static String toPlain(String html) {
        String withBr = html.replace("\r", "").replace("\n", "<br>");
        CharSequence cs = Build.VERSION.SDK_INT >= 24
            ? Html.fromHtml(withBr, Html.FROM_HTML_MODE_LEGACY)
            : Html.fromHtml(withBr);
        return cs.toString().replace(' ', ' ').trim();
    }

    // Langkah terbaru dari pesan proses (baris terakhir yang berarti).
    private static String lastStep(String plain, String fallback) {
        String[] lines = plain.split("\n");
        List<String> steps = new ArrayList<>();
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i].trim();
            if (l.isEmpty() || l.startsWith("…")) continue;
            steps.add(l);
        }
        if (steps.isEmpty()) return fallback;
        String last = steps.get(steps.size() - 1);
        if (last.startsWith("menunggu Claude mulai")) return "Menunggu Claude mulai…";
        return last;
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        return nl >= 0 ? s.substring(0, nl) : s;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String nz(String s) { return s == null ? "" : s; }

    private static String trimSlash(String s) {
        s = nz(s).trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }
}
