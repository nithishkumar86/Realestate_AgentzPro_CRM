interface Window {
  FB?: {
    login: (callback: (response: { authResponse?: { accessToken?: string } }) => void, options: { config_id: string; response_type: "token"; override_default_response_type: true }) => void;
  };
}
