/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/feedback.stories — gallery stories for spinners, progress bars, and toasts.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/gallery` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import {
  Button,
  HStack,
  ProgressBar,
  Spinner,
  Text,
  Toast,
  ToastStack,
  VStack,
  styles,
} from 'fino:ui/components';
import type { StatusVariant } from 'fino:ui/components';
import type { StoryGroup } from 'internal:ui/story';

export function feedbackStories(): StoryGroup {
  const toasts = createSignal<Array<{ id: string; message: string; variant?: StatusVariant }>>([]);
  let toastId = 0;
  const pushToast = (variant: StatusVariant, message: string): void => {
    toastId += 1;
    toasts.set([
      ...toasts.get(),
      { id: String(toastId), message: `${message} #${toastId}`, variant },
    ]);
  };
  return {
    title: 'Feedback',
    stories: [
      {
        key: 'spinner',
        name: 'Spinner',
        controls: {
          pinned: { type: 'boolean', label: 'pin a frame', default: false },
          tick: { type: 'number', default: 0, min: 0 },
        },
        view: (args) => (
          <VStack gap={1}>
            <HStack gap={1}>
              {args.pinned === true ? <Spinner tick={Number(args.tick)} /> : <Spinner />}
              <Text style={[styles.muted]}>
                {args.pinned === true ? `pinned to tick ${String(args.tick)}` : 'animating'}
              </Text>
            </HStack>
            <Text style={[styles.dim]}>
              Left to itself the terminal spinner runs its own clock; pin a tick to freeze it.
            </Text>
          </VStack>
        ),
      },
      {
        key: 'progress',
        name: 'ProgressBar',
        controls: {
          value: { type: 'number', default: 40, step: 10, min: 0, max: 100 },
          showPercent: { type: 'boolean', default: true },
        },
        view: (args) => (
          <ProgressBar
            value={Number(args.value) / 100}
            width={24}
            showPercent={args.showPercent === true}
          />
        ),
      },
      {
        key: 'toasts',
        name: 'Toast & ToastStack',
        view: () => (
          <VStack gap={1}>
            <HStack gap={1}>
              <Button label="Info" onClick={() => pushToast('info', 'Heads up')} />
              <Button label="Success" onClick={() => pushToast('success', 'Saved')} />
              <Button label="Danger" onClick={() => pushToast('danger', 'Failed')} />
              <Button label="Clear" onClick={() => toasts.set([])} />
            </HStack>
            <Toast message="Standalone toast" variant="warning" />
            <Text style={[styles.muted]}>{`${toasts.get().length} stacked`}</Text>
            <ToastStack toasts={toasts.get()} />
          </VStack>
        ),
      },
    ],
  };
}
