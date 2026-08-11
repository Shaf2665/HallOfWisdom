import type { ReactNode } from "react";
import "./globals.css";
import { HallAuthGate } from "../components/hall-auth-gate";

export const metadata = {
  title: "Hall of Wisdom",
  description: "A calm dashboard for orchestrating coding agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HallAuthGate>{children}</HallAuthGate>
      </body>
    </html>
  );
}
