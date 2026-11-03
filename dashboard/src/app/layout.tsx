import type { Metadata } from 'next';
import '@cloudlet/toast/styles.css';
import { NotificationOwner } from '@/components/notification-owner';
import './globals.css';
export const metadata: Metadata = {
  title: 'CrowdReply · AI visibility',
  description: 'Inspect provider answers, execution provenance and live spend.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <NotificationOwner>{children}</NotificationOwner>
      </body>
    </html>
  );
}
