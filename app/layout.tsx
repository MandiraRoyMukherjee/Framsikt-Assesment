import type { ReactNode } from "react";

export const metadata = {
  title: "Snack Counter Automation",
  description: "Refill lifecycle, fair volunteer selection and budget control for the Oslo and Bengaluru snack counters",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
          margin: 0,
          background: "#f7f8fa",
          color: "#1f2328",
          lineHeight: 1.55,
        }}
      >
        {children}
      </body>
    </html>
  );
}
