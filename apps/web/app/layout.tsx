import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FileTasks · Your personal workspace",
  description: "A little space for everything you need to do and remember.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
