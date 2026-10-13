import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Traveller | Trip planner",
  description: "Plan city visits, bookings and travel routes.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}