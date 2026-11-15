package cz.croober.kviz.link;

import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Collections;
import java.util.Enumeration;
import java.util.concurrent.atomic.AtomicInteger;

// Most mezi JS a lokálním serverem (LinkServer). Rozhraní popisuje kontrakt.md § 1; herní logiku nezná.
@CapacitorPlugin(name = "KvizLink")
public class KvizLinkPlugin extends Plugin {
    private static final String TAG = "KvizLink";
    private static final int DEFAULT_PORT = 8765;
    private static final int EXTRA_PORT_ATTEMPTS = 9; // obsazený port → zkusí port+1 až port+9
    private static final int MIN_PORT = 1024; // nižší porty Android aplikaci nepovolí
    private static final int MAX_PORT = 65535;

    // Id spojení roste po celou dobu běhu aplikace, i přes restart serveru (jiný token), aby se v JS nepletla.
    private final AtomicInteger nextConnectionId = new AtomicInteger(1);

    // Zapisuje se pod zámkem (start, stop, životní cyklus aktivity); send/info/broadcast čtou bez zámku.
    private volatile LinkServer server;
    private volatile String token;
    private volatile int port;
    // Server zastavený kvůli aktivitě na pozadí; handleOnStart ho s nimi obnoví. null = nic k obnovení.
    private String pausedToken;
    private int pausedPort;

    @PluginMethod
    public void start(PluginCall call) {
        String newToken = call.getString("token");
        if (newToken == null || newToken.isEmpty()) {
            call.reject("Chybí token", "invalid");
            return;
        }
        int requestedPort = call.getInt("port", DEFAULT_PORT);
        // Port mimo rozsah NanoHTTPD neohlásí chybou, ale start() pak čeká donekonečna a zasekne vlákno pluginů.
        if (requestedPort < MIN_PORT || requestedPort > MAX_PORT - EXTRA_PORT_ATTEMPTS) {
            call.reject("Neplatný port", "invalid");
            return;
        }
        JSObject state;
        synchronized (this) {
            // stejný token = jen vrátit stav; jiný token = restart a odpojení klientů
            if (server != null && newToken.equals(token)) {
                call.resolve(stateObject());
                return;
            }
            stopServer();
            pausedToken = null;
            if (!startOnFreePort(requestedPort, newToken)) {
                call.reject("Porty " + requestedPort + "–" + (requestedPort + EXTRA_PORT_ATTEMPTS) + " jsou obsazené", "port_busy");
                return;
            }
            state = stateObject();
        }
        notifyListeners("state", state);
        call.resolve(state);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSObject state;
        synchronized (this) {
            stopServer();
            pausedToken = null;
            state = stateObject();
        }
        notifyListeners("state", state);
        call.resolve(new JSObject().put("running", false));
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject result = stateObject();
        JSArray clients = new JSArray();
        LinkServer current = server;
        if (current != null) {
            for (LinkServer.ClientInfo client : current.clientInfos()) {
                JSObject item = new JSObject();
                item.put("id", client.id);
                item.put("rttMs", client.rttMs < 0 ? JSONObject.NULL : client.rttMs);
                clients.put(item);
            }
        }
        result.put("clients", clients);
        call.resolve(result);
    }

    @PluginMethod
    public void send(PluginCall call) {
        Integer id = call.getInt("id");
        String data = call.getString("data");
        if (id == null || data == null) {
            call.reject("Chybí id nebo data", "invalid");
            return;
        }
        long sentAt = SystemClock.elapsedRealtime();
        LinkServer current = server;
        if (current == null || !current.send(id, data)) {
            call.reject("Spojení " + id + " neexistuje", "no_client");
            return;
        }
        call.resolve(new JSObject().put("sentAt", sentAt));
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Chybí data", "invalid");
            return;
        }
        long sentAt = SystemClock.elapsedRealtime();
        LinkServer current = server;
        int count = current == null ? 0 : current.broadcast(data);
        call.resolve(new JSObject().put("sentAt", sentAt).put("count", count));
    }

    @PluginMethod
    public void close(PluginCall call) {
        Integer id = call.getInt("id");
        if (id == null) {
            call.reject("Chybí id", "invalid");
            return;
        }
        LinkServer current = server;
        if (current != null) current.close(id, call.getString("reason"));
        call.resolve();
    }

    // Server smí běžet jen s aplikací v popředí: na pozadí se zastaví (odpojí klienty, uvolní port)
    // a po návratu se obnoví se stejným portem a tokenem.
    @Override
    protected void handleOnStop() {
        JSObject state;
        synchronized (this) {
            if (server == null) return;
            pausedToken = token;
            pausedPort = port;
            stopServer();
            state = stateObject();
        }
        notifyListeners("state", state);
    }

    @Override
    protected void handleOnStart() {
        JSObject state;
        synchronized (this) {
            if (pausedToken == null || server != null) return;
            // Port mezitím mohl obsadit někdo jiný – pak se použije další volný, JS se ho dozví ze state.
            if (!startOnFreePort(pausedPort, pausedToken)) {
                Log.w(TAG, "Obnova serveru selhala, porty od " + pausedPort + " jsou obsazené");
            }
            pausedToken = null;
            state = stateObject();
        }
        notifyListeners("state", state);
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) {
            stopServer();
            pausedToken = null;
        }
    }

    private boolean startOnFreePort(int firstPort, String serverToken) {
        // Strop MAX_PORT: port mimo rozsah by zasekl start() NanoHTTPD (viz kontrola v start).
        int lastPort = Math.min(firstPort + EXTRA_PORT_ATTEMPTS, MAX_PORT);
        for (int candidate = firstPort; candidate <= lastPort; candidate++) {
            LinkServer attempt = new LinkServer(candidate, serverToken, getContext().getAssets(), nextConnectionId, serverListener);
            try {
                attempt.startServer();
                server = attempt;
                port = candidate;
                token = serverToken;
                return true;
            } catch (IOException e) {
                attempt.stop(); // uvolní nespojený socket
                Log.d(TAG, "Port " + candidate + " nejde použít: " + e.getMessage());
            }
        }
        return false;
    }

    private void stopServer() {
        if (server == null) return;
        server.stop();
        server = null;
        token = null;
    }

    private JSObject stateObject() {
        JSObject state = new JSObject();
        boolean running = server != null;
        state.put("running", running);
        state.put("port", running ? port : JSONObject.NULL);
        state.put("addresses", running ? siteLocalAddresses() : new JSArray());
        return state;
    }

    // IPv4 adresy v lokální síti (192.168.x.x, 10.x.x.x, 172.16–31.x.x), bez loopbacku – na ně se připojí mobil.
    private static JSArray siteLocalAddresses() {
        JSArray result = new JSArray();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return result; // zařízení nemá žádné síťové rozhraní
            for (NetworkInterface networkInterface : Collections.list(interfaces)) {
                if (!networkInterface.isUp() || networkInterface.isLoopback()) continue;
                for (InetAddress address : Collections.list(networkInterface.getInetAddresses())) {
                    if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                        result.put(address.getHostAddress());
                    }
                }
            }
        } catch (SocketException e) {
            Log.w(TAG, "Nelze zjistit adresy", e);
        }
        return result;
    }

    private final LinkServer.Listener serverListener = new LinkServer.Listener() {
        @Override
        public void onOpen(int id, long rx) {
            notifyListeners("open", new JSObject().put("id", id).put("rx", rx));
        }

        @Override
        public void onMessage(int id, String data, long rx) {
            notifyListeners("message", new JSObject().put("id", id).put("data", data).put("rx", rx));
        }

        @Override
        public void onClose(int id, String reason) {
            notifyListeners("close", new JSObject().put("id", id).put("reason", reason));
        }

        @Override
        public void onRtt(int id, long ms) {
            notifyListeners("rtt", new JSObject().put("id", id).put("ms", ms));
        }
    };
}
