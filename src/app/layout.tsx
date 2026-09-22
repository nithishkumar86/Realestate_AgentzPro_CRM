import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AgentzPro CRM", template: "%s | AgentzPro CRM" },
  description: "Lead management for AgentzPro Real Estate.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("agentzpro-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch{document.documentElement.dataset.theme="light"}try{document.documentElement.dataset.sidebar=localStorage.getItem("agentzpro-sidebar")==="collapsed"?"collapsed":"expanded"}catch{document.documentElement.dataset.sidebar="expanded"}`,
          }}
        />
        {/* The default Supabase invite email returns to the Site URL with the session in the URL
            fragment (#access_token=…&type=invite). Forward it to /auth/confirm, which sets the
            cookie session and continues to the invited member's setup. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var h=location.hash;if(h.indexOf("access_token=")>-1&&h.indexOf("type=invite")>-1&&location.pathname!=="/auth/confirm"){location.replace("/auth/confirm"+h)}}catch{}`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
