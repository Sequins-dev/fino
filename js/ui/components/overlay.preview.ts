/** Co-located previews for overlay components. @internal */
import { createSignal, h } from 'fino:ui';
import { Button, Modal, Popover, ToastStack, VStack } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build overlay-family previews for a catalog host. */
export function overlayPreviews(): PreviewGroup {
  const modalOpen = createSignal(true);
  const popoverOpen = createSignal(true);
  return {
    title: 'Overlays',
    previews: [
      {
        key: 'modal',
        name: 'Modal',
        view: () =>
          h(
            VStack,
            null,
            h(Button, { label: 'Open modal', onClick: () => modalOpen.set(true) }),
            modalOpen.get()
              ? h(
                  Modal,
                  { title: 'Confirm', onDismiss: () => modalOpen.set(false) },
                  'Review this action before continuing.',
                )
              : null,
          ),
      },
      {
        key: 'popover',
        name: 'Popover',
        view: () =>
          h(
            VStack,
            null,
            h(Button, {
              id: 'preview-popover-trigger',
              label: 'Toggle',
              onClick: () => popoverOpen.set(!popoverOpen.get()),
            }),
            h(
              Popover,
              {
                open: popoverOpen.get(),
                anchorId: 'preview-popover-trigger',
                onDismiss: () => popoverOpen.set(false),
              },
              'Anchored content',
            ),
          ),
      },
      {
        key: 'toasts',
        name: 'Toasts',
        view: () =>
          h(ToastStack, {
            toasts: [
              { id: 'saved', message: 'Saved', variant: 'success' },
              { id: 'offline', message: 'Offline', variant: 'warning' },
            ],
          }),
      },
    ],
  };
}
