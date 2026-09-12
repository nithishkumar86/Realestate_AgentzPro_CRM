import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SDK_SELECTOR = 'script[src="https://connect.facebook.net/en_US/sdk.js"]';

async function importLoader() {
  vi.resetModules();
  return (await import("@/features/connection/facebook-sdk")).loadFacebookSdk;
}

function simulateSdkReady(init = vi.fn()) {
  window.FB = { init, login: vi.fn() };
  window.fbAsyncInit?.();
  return init;
}

describe("loadFacebookSdk", () => {
  beforeEach(() => {
    delete window.FB;
    delete window.fbAsyncInit;
  });

  afterEach(() => {
    document.querySelectorAll(SDK_SELECTOR).forEach((script) => script.remove());
  });

  it("defines fbAsyncInit before injecting the SDK script with Meta's documented attributes", async () => {
    const loadFacebookSdk = await importLoader();
    void loadFacebookSdk("app-1", "v25.0");

    expect(typeof window.fbAsyncInit).toBe("function");
    const script = document.querySelector<HTMLScriptElement>(SDK_SELECTOR);
    expect(script).not.toBeNull();
    expect(script?.async).toBe(true);
    expect(script?.defer).toBe(true);
    expect(script?.crossOrigin).toBe("anonymous");
  });

  it("calls FB.init with the app ID and version, then resolves, only once the SDK invokes fbAsyncInit", async () => {
    const loadFacebookSdk = await importLoader();
    let resolved = false;
    const ready = loadFacebookSdk("app-1", "v25.0").then(() => { resolved = true; });

    document.querySelector(SDK_SELECTOR)?.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(resolved).toBe(false);

    const init = simulateSdkReady();
    await ready;
    expect(init).toHaveBeenCalledExactlyOnceWith({ appId: "app-1", version: "v25.0" });
  });

  it("reuses the same initialization on repeated calls instead of injecting the script again", async () => {
    const loadFacebookSdk = await importLoader();
    const first = loadFacebookSdk("app-1", "v25.0");
    const init = simulateSdkReady();
    await first;

    await expect(loadFacebookSdk("app-1", "v25.0")).resolves.toBeUndefined();
    expect(document.querySelectorAll(SDK_SELECTOR)).toHaveLength(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of waiting forever when FB.init rejects the configuration", async () => {
    const loadFacebookSdk = await importLoader();
    const ready = loadFacebookSdk("app-1", "not-a-version");
    simulateSdkReady(vi.fn(() => { throw new Error("invalid version specified"); }));

    await expect(ready).rejects.toThrow("Facebook authorization is not available. Verify the public Meta configuration.");
  });

  it("rejects when the SDK script fails to load and allows a later retry", async () => {
    const loadFacebookSdk = await importLoader();
    const failed = loadFacebookSdk("app-1", "v25.0");
    document.querySelector(SDK_SELECTOR)?.dispatchEvent(new Event("error"));

    await expect(failed).rejects.toThrow("Facebook authorization could not be loaded.");
    expect(document.querySelector(SDK_SELECTOR)).toBeNull();

    const retry = loadFacebookSdk("app-1", "v25.0");
    expect(document.querySelectorAll(SDK_SELECTOR)).toHaveLength(1);
    simulateSdkReady();
    await expect(retry).resolves.toBeUndefined();
  });
});
