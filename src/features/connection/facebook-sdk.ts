const FACEBOOK_SDK_SOURCE = "https://connect.facebook.net/en_US/sdk.js";

let sdkInitialization: Promise<void> | null = null;

/**
 * Loads and initializes the Meta JavaScript SDK once per page lifetime.
 *
 * Follows Meta's documented setup (developers.facebook.com/docs/javascript/quickstart):
 * define `window.fbAsyncInit`, then load sdk.js asynchronously. The SDK calls
 * `fbAsyncInit` once it is fully loaded, and `FB.init` must run there before any
 * other SDK method (developers.facebook.com/docs/javascript/reference/FB.init/).
 * sdk.js itself is only a loader stub, so its `load` event does not mean the SDK
 * is ready.
 *
 * The promise is module-scoped so a page that remounts after client-side
 * navigation reuses the already initialized SDK instead of waiting for a load
 * event that never fires again. A failed script load clears it so a later
 * mount can retry.
 */
export function loadFacebookSdk(appId: string, version: string): Promise<void> {
  if (sdkInitialization) return sdkInitialization;

  sdkInitialization = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) {
        reject(new Error("Facebook authorization could not be loaded."));
        return;
      }
      // FB.init throws for an invalid version string; without this the
      // promise would never settle and the page would wait indefinitely.
      try {
        window.FB.init({ appId, version });
      } catch {
        reject(new Error("Facebook authorization is not available. Verify the public Meta configuration."));
        return;
      }
      resolve();
    };

    const script = document.createElement("script");
    script.src = FACEBOOK_SDK_SOURCE;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("error", () => {
      script.remove();
      sdkInitialization = null;
      reject(new Error("Facebook authorization could not be loaded."));
    });
    document.body.appendChild(script);
  });

  return sdkInitialization;
}
