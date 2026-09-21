import type { Metadata, Viewport } from "next";
import { Barlow } from "next/font/google";
import "./globals.css";

const barlow = Barlow({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-barlow", display: "swap" });

export const metadata: Metadata = {
  title: "NE Surf Overview — New England surf forecast",
  description: "Free, open-source surf forecast for Rhode Island, Massachusetts, New Hampshire and Maine built on NOAA data.",
};
export const viewport: Viewport = { themeColor: "#0E2029", viewportFit: "cover", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
