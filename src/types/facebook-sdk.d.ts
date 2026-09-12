interface Window {
  fbAsyncInit?: () => void;
  FB?: {
    init: (options: { appId: string; version: string }) => void;
    // https://developers.facebook.com/docs/reference/javascript/FB.getLoginStatus#response_and_session_objects
    login: (callback: (response: {
      status?: "connected" | "not_authorized" | "unknown";
      authResponse?: { accessToken?: string; expiresIn?: number; userID?: string; signedRequest?: string } | null;
    }) => void, options: {
      config_id: string;
      response_type: "token";
      override_default_response_type: true;
      /**
       * Re-asks for permissions the person previously declined. Meta only re-offers them when this is
       * set: "once someone has declined a permission, the Login Dialog will not re-ask them for it unless
       * you explicitly tell the dialog you're re-asking for a declined permission"
       * (https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow).
       */
      auth_type?: "rerequest";
    }) => void;
  };
}
