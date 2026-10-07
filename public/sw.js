// Service worker for task alerts. It only shows push notifications and opens the Tasks page on click;
// it caches nothing and handles no fetches.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || "Task reminder", {
    body: data.body || "",
    tag: data.tag || "task-reminder",
    data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/tasks" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/tasks";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) { client.navigate(url); return client.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
