import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Traveller | Your city, in good order",
  description: "A personal city itinerary with room for the places that matter.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}