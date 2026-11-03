'use client';
import { startTransition, useEffect, useState, type ReactNode } from 'react';
import {
  CloudletProvider,
  createCloudlet,
  Toaster,
  type ReactCloudletController,
} from '@cloudlet/toast';

export function NotificationOwner({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<ReactCloudletController | null>(
    null,
  );
  useEffect(() => {
    const instance = createCloudlet();
    startTransition(() => setController(instance));
    return () => instance.dispose();
  }, []);
  return (
    <CloudletProvider controller={controller}>
      {children}
      <Toaster position="bottom-center" theme="light" />
    </CloudletProvider>
  );
}
