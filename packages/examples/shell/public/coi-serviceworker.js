/*  Service worker that enables SharedArrayBuffer on GitHub Pages */
let coepCredentialless = false;
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) return;
        if (ev.data.type === "deregister") {
            self.registration.unregister()
                .then(() => self.clients.matchAll())
                .then(clients => clients.forEach((client) => client.navigate(client.url)));
        } else if (ev.data.type === "coepCredentialless") {
            coepCredentialless = ev.data.value;
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;
        if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, { credentials: "omit" })
            : r;

        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) return response;

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");

        const n = navigator;

        if (window.crossOriginIsolated !== false) return;
        if (!window.isSecureContext) {
            console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }
        if (!n.serviceWorker) {
            console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }
        if (reloadedBySelf) return;

        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                console.log("COOP/COEP Service Worker registered", registration.scope);

                registration.addEventListener("updatefound", () => {
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
                    window.location.reload();
                });

                if (registration.active && !n.serviceWorker.controller) {
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    window.location.reload();
                }
            },
            (err) => {
                console.error("COOP/COEP Service Worker failed to register:", err);
            }
        );
    })();
}
