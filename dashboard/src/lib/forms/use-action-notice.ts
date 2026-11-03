'use client';
import { useOptionalCloudlet, type NotificationHandle } from '@cloudlet/toast';

type Notice = { title: string; description?: string; error?: boolean };

/** Notices supplement the persistent form feedback; they never retry work. */
export function useActionNotice() {
  const controller = useOptionalCloudlet();
  return {
    begin(title: string): NotificationHandle | null {
      const result = controller?.show({
        title,
        kind: 'loading',
        attention: 'stack',
        announcementPriority: 'off',
      });
      return result && result.status !== 'rejected' ? result.handle : null;
    },
    finish(handle: NotificationHandle | null, notice: Notice) {
      const content = {
        title: notice.title,
        kind: notice.error ? ('error' as const) : ('success' as const),
        ...(notice.description
          ? { description: { kind: 'text' as const, text: notice.description } }
          : {}),
        duration: notice.error ? null : 6000,
        attention: 'stack' as const,
        announcementPriority: 'off' as const,
      };
      if (handle) controller?.update(handle, content);
      else controller?.show(content);
    },
  };
}
