// Required by Firebase Cloud Messaging to deliver push notifications when the app
// isn't open/focused. Must be served from the site root (not a subfolder) — that's
// a Firebase requirement, not a choice made here.
//
// Only handles background push delivery + notification clicks. Does not touch,
// override, or interfere with any other part of the app.

importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// Same public, safe-to-expose config used in index.html.
firebase.initializeApp({
  apiKey: "AIzaSyDHaAKYS1BLEwhAB1PltjNVx80y-2gAS28",
  authDomain: "tna-pcd-mb.firebaseapp.com",
  projectId: "tna-pcd-mb",
  storageBucket: "tna-pcd-mb.firebasestorage.app",
  messagingSenderId: "444746426348",
  appId: "1:444746426348:web:e6f74ecd19befd8bf7c2c9"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'TNA Task Reminder';
  const body = (payload.notification && payload.notification.body) || '';
  const orderId = (payload.data && payload.data.orderId) || null;
  self.registration.showNotification(title, {
    body,
    data: { orderId }
  });
});

// Clicking the notification opens (or focuses) the app and jumps straight to the
// relevant order, via a "#order=<id>" hash that index.html reads on load.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const orderId = event.notification.data && event.notification.data.orderId;
  const url = orderId ? `/#order=${encodeURIComponent(orderId)}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
