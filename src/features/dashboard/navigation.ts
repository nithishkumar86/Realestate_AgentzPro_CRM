// Full-page navigations the live dashboard needs, kept behind a seam so tests can observe them.
// (jsdom's window.location cannot be stubbed.) Both are hard navigations on purpose: they discard all
// client state, which is exactly what a signed-out session or a company switch requires.

export function reloadPage(): void {
  window.location.reload();
}

export function goToLogin(): void {
  window.location.replace("/login");
}
