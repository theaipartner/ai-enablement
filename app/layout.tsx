import type { Metadata } from "next";
import localFont from "next/font/local";
import { Instrument_Serif, Inter } from "next/font/google";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

// Editorial-dark fonts hoisted to root so both Gregory's editorial theme
// and (post-merge) the Promethean theme can reference the same CSS
// variables. Google Fonts requests are deduped by Next.js.
const prometheanSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-prom-serif",
  display: "swap",
});
const prometheanSans = Inter({
  subsets: ["latin"],
  variable: "--font-prom-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Gregory",
  description: "CSM dashboard for The AI Partner.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${prometheanSerif.variable} ${prometheanSans.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
