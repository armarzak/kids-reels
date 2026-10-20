// Сервис-воркер нужен только ради пушей: кэширование намеренно не трогаем,
// иначе приложение начнёт показывать устаревшую версию само себе.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* прислали не JSON */ }

  event.waitUntil(self.registration.showNotification(data.title || 'Новое видео', {
    body: data.body || 'В ленте появилось новое видео',
    icon: 'icon-512.png',
    badge: 'icon-180.png',
    // Один тег: несколько добавлений подряд схлопнутся в одно уведомление,
    // а не завалят экран.
    tag: 'kidsreels-new',
    renotify: true,
    data: { url: data.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(url);
    })
  );
});
