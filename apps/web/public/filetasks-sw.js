self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "FileTasks reminder", body: event.data.text() };
  }

  const reminder = payload.reminder ?? payload;
  const title = reminder.title || "FileTasks reminder";
  const date = reminder.scheduledAt ? new Date(reminder.scheduledAt) : null;
  const body = payload.body || (date && !Number.isNaN(date.getTime())
    ? `Scheduled for ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}`
    : "A reminder is due.");

  event.waitUntil(self.registration.showNotification(title, {
    body,
    data: { itemId: reminder.itemId || null },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const itemId = event.notification.data?.itemId;
  const target = itemId ? `/?item=${encodeURIComponent(itemId)}` : "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) {
        void client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
