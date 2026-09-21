import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NE Surf — New England surf forecast",
  description: "Free, open-source surf forecast for Rhode Island, Massachusetts, New Hampshire and Maine built on NOAA data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
