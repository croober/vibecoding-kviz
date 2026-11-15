package cz.croober.kviz.link;

import android.content.res.AssetManager;
import android.os.SystemClock;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoWSD;
import fi.iki.elonen.NanoWSD.WebSocketFrame.CloseCode;
import fi.iki.elonen.NanoWSD.WebSocketFrame.OpCode;

// Lokální server pro mobilní ovládání: stránka ovladače z assets a WebSocket chráněný tokenem.
// Jen přenos zpráv – herní logiku řeší JS (plugin KvizLink).
public class LinkServer extends NanoWSD {
    private static final String TAG = "KvizLink";
    private static final String WS_PATH = "/ws";
    private static final String TOKEN_PARAM = "t";
    private static final int MAX_CLIENTS = 16;
    // Ven smí jen tyto složky assets. V kořeni assets leží tv-config.js s tokenem a basic auth serveru kvízu,
    // proto povolený seznam složek, ne zakázaný seznam souborů.
    private static final String MOBILE_PREFIX = "/m/";
    private static final String MOBILE_ASSETS = "public/mobile/";
    private static final String VENDOR_PREFIX = "/vendor/";
    private static final String VENDOR_ASSETS = "public/vendor/";
    private static final String INDEX_FILE = "index.html";
    private static final String TEXT_CHARSET = "; charset=utf-8";
    private static final Map<String, String> MIME_TYPES = new HashMap<>();

    static {
        MIME_TYPES.put("html", "text/html" + TEXT_CHARSET);
        MIME_TYPES.put("js", "text/javascript" + TEXT_CHARSET);
        MIME_TYPES.put("css", "text/css" + TEXT_CHARSET);
        MIME_TYPES.put("svg", "image/svg+xml" + TEXT_CHARSET);
        MIME_TYPES.put("json", "application/json" + TEXT_CHARSET);
        MIME_TYPES.put("woff2", "font/woff2");
        MIME_TYPES.put("woff", "font/woff");
        MIME_TYPES.put("ttf", "font/ttf");
        MIME_TYPES.put("png", "image/png");
    }

    // NanoHTTPD 2.3.1 nemá ve výčtu Status kód 302.
    private static final Response.IStatus FOUND = new Response.IStatus() {
        @Override
        public String getDescription() {
            return "302 Found";
        }

        @Override
        public int getRequestStatus() {
            return 302;
        }
    };
    // NanoHTTPD má výchozí limit čtení 5 s, po kterém by nečinné spojení spadlo. Ping každé 2 s drží provoz,
    // takže delší limit odpojí jen klienta, který přestal odpovídat.
    private static final int SOCKET_TIMEOUT_MS = 15000;
    private static final long PING_INTERVAL_MS = 2000;
    private static final int MAX_MESSAGE_BYTES = 4096;

    // Události pro plugin; volají se z vláken serveru.
    public interface Listener {
        void onOpen(int id, long rx);

        void onMessage(int id, String data, long rx);

        void onClose(int id, String reason);

        void onRtt(int id, long ms);
    }

    // Stav jednoho spojení pro výpis v info().
    public static final class ClientInfo {
        public final int id;
        public final long rttMs; // -1 = zatím bez pongu

        ClientInfo(int id, long rttMs) {
            this.id = id;
            this.rttMs = rttMs;
        }
    }

    private final AssetManager assets;
    private final byte[] token; // jiný token = nový server (restart v pluginu)
    private final Listener listener;
    private final AtomicInteger nextId; // sdílí ho plugin, aby id rostlo i přes restart serveru
    private final Map<Integer, Client> clients = new ConcurrentHashMap<>();
    private ScheduledExecutorService pinger;

    public LinkServer(int port, String token, AssetManager assets, AtomicInteger nextId, Listener listener) {
        super(port);
        this.token = token.getBytes(StandardCharsets.UTF_8);
        this.assets = assets;
        this.nextId = nextId;
        this.listener = listener;
    }

    // Spustí server a pravidelné pingy. IOException = port je obsazený.
    public void startServer() throws IOException {
        start(SOCKET_TIMEOUT_MS, true);
        pinger = Executors.newSingleThreadScheduledExecutor();
        pinger.scheduleAtFixedRate(this::pingAll, PING_INTERVAL_MS, PING_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    @Override
    public void stop() {
        if (pinger != null) {
            pinger.shutdownNow();
            pinger = null;
        }
        super.stop(); // zavře i všechna spojení → onClose u každého klienta
    }

    // false = spojení s tímto id neexistuje nebo odeslání selhalo
    public boolean send(int id, String data) {
        Client client = clients.get(id);
        return client != null && client.sendText(data);
    }

    public int broadcast(String data) {
        int count = 0;
        for (Client client : clients.values()) {
            if (client.sendText(data)) count++;
        }
        return count;
    }

    public boolean close(int id, String reason) {
        Client client = clients.get(id);
        if (client == null) return false;
        client.closeWith(CloseCode.NormalClosure, reason);
        return true;
    }

    public List<ClientInfo> clientInfos() {
        List<ClientInfo> list = new ArrayList<>();
        for (Client client : clients.values()) {
            list.add(new ClientInfo(client.id, client.rttMs));
        }
        return list;
    }

    // getUri() je už dekódovaná (%2e%2e → ..), kontrola cest proto vidí skutečné názvy.
    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        if (uri == null) return notFound(); // neplatné %-kódování
        if (WS_PATH.equals(uri)) return serveWebSocket(session);
        if (session.getMethod() != Method.GET) return notFound();
        if ("/".equals(uri)) return redirect(MOBILE_PREFIX);
        if (uri.startsWith(MOBILE_PREFIX)) return serveAsset(MOBILE_ASSETS, uri.substring(MOBILE_PREFIX.length()));
        if (uri.startsWith(VENDOR_PREFIX)) return serveAsset(VENDOR_ASSETS, uri.substring(VENDOR_PREFIX.length()));
        return notFound();
    }

    // Obyčejný HTTP požadavek na /ws (bez upgrade).
    @Override
    protected Response serveHttp(IHTTPSession session) {
        return notFound();
    }

    private Response serveWebSocket(IHTTPSession session) {
        if (!hasValidToken(session)) {
            return newFixedLengthResponse(Response.Status.FORBIDDEN, NanoHTTPD.MIME_PLAINTEXT, "Forbidden");
        }
        // Počítají se jen otevřená spojení; souběžné handshaky mohou limit krátce překročit.
        if (clients.size() >= MAX_CLIENTS) {
            return newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, NanoHTTPD.MIME_PLAINTEXT, "Too many connections");
        }
        return super.serve(session);
    }

    // Porovnání v konstantním čase, aby se token nedal hádat po znacích podle doby odpovědi.
    private boolean hasValidToken(IHTTPSession session) {
        List<String> values = session.getParameters().get(TOKEN_PARAM);
        if (values == null || values.size() != 1 || values.get(0) == null) return false;
        return MessageDigest.isEqual(token, values.get(0).getBytes(StandardCharsets.UTF_8));
    }

    private Response serveAsset(String folder, String relativePath) {
        String path = relativePath.isEmpty() ? INDEX_FILE : relativePath;
        if (!isSafeRelativePath(path)) return notFound();
        String mimeType = MIME_TYPES.get(extension(path));
        if (mimeType == null) return notFound(); // jen vyjmenované typy obsahu
        InputStream stream;
        try {
            stream = assets.open(folder + path);
        } catch (IOException e) {
            return notFound(); // chybějící soubor nebo složka
        }
        // NanoHTTPD proud po odeslání zavře.
        Response response = newChunkedResponse(Response.Status.OK, mimeType, stream);
        response.addHeader("Cache-Control", "no-cache");
        return response;
    }

    // Cesta uvnitř povolené složky: bez „..“ (kdekoli), zpětného lomítka, nulového znaku a segmentů „.“
    // či prázdných, takže složku nemůže opustit ani po dekódování.
    private static boolean isSafeRelativePath(String path) {
        if (path.contains("..") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return false;
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || ".".equals(segment)) return false;
        }
        return true;
    }

    private static String extension(String path) {
        int dot = path.lastIndexOf('.');
        return dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static Response redirect(String location) {
        Response response = newFixedLengthResponse(FOUND, NanoHTTPD.MIME_PLAINTEXT, "");
        response.addHeader("Location", location);
        return response;
    }

    @Override
    protected WebSocket openWebSocket(IHTTPSession handshake) {
        return new Client(handshake, nextId.getAndIncrement());
    }

    private static Response notFound() {
        return newFixedLengthResponse(Response.Status.NOT_FOUND, NanoHTTPD.MIME_PLAINTEXT, "Not Found");
    }

    private void pingAll() {
        // Výjimka v naplánované úloze by zastavila další pingy, proto se zachytává celá.
        try {
            byte[] payload = ByteBuffer.allocate(Long.SIZE / Byte.SIZE).putLong(SystemClock.elapsedRealtime()).array();
            for (Client client : clients.values()) {
                client.sendPing(payload);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Ping selhal", e);
        }
    }

    // Chyba v posluchači (JS most) nesmí shodit vlákno serveru.
    private void safely(Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            Log.w(TAG, "Posluchač selhal", e);
        }
    }

    private final class Client extends WebSocket {
        final int id;
        volatile long rttMs = -1;
        private volatile String ownCloseReason; // důvod, když spojení zavírá TV

        Client(IHTTPSession handshake, int id) {
            super(handshake);
            this.id = id;
        }

        boolean sendText(String data) {
            try {
                send(data);
                return true;
            } catch (IOException e) {
                Log.w(TAG, "Odeslání klientovi " + id + " selhalo", e);
                return false;
            }
        }

        void sendPing(byte[] payload) {
            if (!isOpen()) return;
            try {
                ping(payload);
            } catch (IOException e) {
                // spojení je mrtvé; zavře ho smyčka čtení (vyprší limit nebo spadne socket)
                Log.d(TAG, "Ping klientovi " + id + " selhal", e);
            }
        }

        void closeWith(CloseCode code, String reason) {
            ownCloseReason = reason;
            try {
                close(code, reason == null ? "" : reason, false);
            } catch (IOException e) {
                Log.d(TAG, "Zavření klienta " + id + " selhalo", e);
            }
        }

        @Override
        protected void onOpen() {
            clients.put(id, this);
            long rx = SystemClock.elapsedRealtime();
            safely(() -> listener.onOpen(id, rx));
        }

        @Override
        protected void onMessage(WebSocketFrame message) {
            long rx = SystemClock.elapsedRealtime(); // čas příjmu hned na začátku, před jakoukoli prací
            if (message.getOpCode() != OpCode.Text) {
                closeWith(CloseCode.UnsupportedData, "unsupported");
                return;
            }
            if (message.getBinaryPayload().length > MAX_MESSAGE_BYTES) {
                closeWith(CloseCode.MessageTooBig, "too_big");
                return;
            }
            String data = message.getTextPayload();
            safely(() -> listener.onMessage(id, data, rx));
        }

        @Override
        protected void onPong(WebSocketFrame pong) {
            byte[] payload = pong.getBinaryPayload();
            if (payload == null || payload.length != Long.SIZE / Byte.SIZE) return; // nevyžádaný pong
            long ms = SystemClock.elapsedRealtime() - ByteBuffer.wrap(payload).getLong();
            rttMs = ms;
            safely(() -> listener.onRtt(id, ms));
        }

        @Override
        protected void onClose(CloseCode code, String reason, boolean initiatedByRemote) {
            // Spojení, které nedošlo do onOpen (spadlý handshake), JS nezná – událost by byla matoucí.
            if (clients.remove(id) == null) return;
            String finalReason = closeReason(code, reason);
            safely(() -> listener.onClose(id, finalReason));
        }

        @Override
        protected void onException(IOException exception) {
            // běžné při odpojení klienta nebo vypršení limitu čtení; následuje onClose
            Log.d(TAG, "Spojení " + id + ": " + exception.getMessage());
        }

        private String closeReason(CloseCode code, String reason) {
            if (ownCloseReason != null) return ownCloseReason;
            if (reason != null && !reason.isEmpty()) return reason;
            return code != null ? code.name() : "closed";
        }
    }
}
