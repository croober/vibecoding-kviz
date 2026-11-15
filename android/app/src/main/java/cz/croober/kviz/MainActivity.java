package cz.croober.kviz;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

import cz.croober.kviz.link.KvizLinkPlugin;

public class MainActivity extends BridgeActivity {
    // Televize často hlásí hustotu pixelů 2×, takže WebView vidí jen 960 × 540 px a rozhraní (navržené pro ~1920 px) vypadá obří.
    // Se zapnutým „širokým viewportem“ WebView respektuje <meta name="viewport" content="width=1920">, které do stránky
    // vkládá android-tv/prepare.mjs, a celou stránku zmenší, aby se 1920 px vešlo na obrazovku.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KvizLinkPlugin.class); // vlastní plugin se musí zaregistrovat před super.onCreate, jinak ho most nevidí
        super.onCreate(savedInstanceState);
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMediaPlaybackRequiresUserGesture(false); // zvukové odezvy kvízu (tv-sound.js)
    }
}
