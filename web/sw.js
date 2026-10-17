self.addEventListener('push', event => {
    let payload;
    try { payload = event.data.json(); } catch { return; }
    if (!payload || typeof payload.title !== 'string' || typeof payload.body !== 'string') return;
    event.waitUntil(self.registration.showNotification(payload.title, {
        body: payload.body, icon: '/icon.svg', data: { url: payload.url },
    }));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        let url;
        try { url = new URL(event.notification.data?.url || '/', self.location.origin); } catch { return; }
        if (url.origin !== self.location.origin || url.pathname !== '/' || url.hash
            || [...url.searchParams.keys()].some(key => key !== 'thread') || url.searchParams.getAll('thread').length > 1) return;
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = clients.find(client => {
            const target = new URL(client.url);
            return target.origin === url.origin && target.pathname === '/';
        });
        if (existing) {
            existing.postMessage({ type: 'notification-thread', thread: url.searchParams.get('thread') });
            await existing.focus();
        } else await self.clients.openWindow(url.href);
    })());
});
