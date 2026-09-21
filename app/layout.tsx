import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NE Surf Overview — Free Map",
  description: "Free, open-source surf forecast for Rhode Island, Massachusetts, New Hampshire and Maine built on NOAA data.",
};
export const viewport: Viewport = { themeColor: "#0e2029", viewportFit: "cover", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        {/* design/ne-surf-handoff/ui-reference.html loads exactly these faces from Google Fonts */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@500;600;700;800&family=Barlow+Condensed:wght@600;700&display=swap" />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
