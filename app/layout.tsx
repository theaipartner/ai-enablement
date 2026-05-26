import type { Metadata } from "next";
import localFont from "next/font/local";
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

// Vendored via @fontsource* to avoid Google Fonts fetches at compile time
// (WSL network to fonts.googleapis.com is flaky). Same CSS variables
// preserved so consumers don't change.
const prometheanSerif = localFont({
  src: [
    { path: "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-prom-serif",
  display: "swap",
});
const prometheanSans = localFont({
  src: [
    { path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", weight: "100 900", style: "normal" },
    { path: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--font-prom-sans",
  display: "swap",
});
const gregoryEditorialSerif = localFont({
  src: [
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-400-italic.woff2", weight: "400", style: "italic" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-500-italic.woff2", weight: "500", style: "italic" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-600-italic.woff2", weight: "600", style: "italic" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "../node_modules/@fontsource/newsreader/files/newsreader-latin-700-italic.woff2", weight: "700", style: "italic" },
  ],
  variable: "--font-geg-serif",
  display: "swap",
});
const gregoryEditorialMono = localFont({
  src: [
    { path: "../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-geg-mono",
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
        className={`${geistSans.variable} ${geistMono.variable} ${prometheanSerif.variable} ${prometheanSans.variable} ${gregoryEditorialSerif.variable} ${gregoryEditorialMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
