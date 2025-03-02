import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'mithic browser example',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='en' suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  );
}
