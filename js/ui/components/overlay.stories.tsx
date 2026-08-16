/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/overlay.stories — gallery stories for menus, popovers, tooltips, and modals.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/gallery` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import {
  Button,
  ContextMenu,
  MenuList,
  Modal,
  Popover,
  Select,
  Text,
  Tooltip,
  VStack,
  createDisclosure,
  styles,
} from 'fino:ui/components';
import type { MenuItem } from 'fino:ui/components';
import type { StoryGroup } from 'internal:ui/story';

export function overlayStories(): StoryGroup {
  const modal = createDisclosure(false);
  const select = createDisclosure(false);
  const model = createSignal<string | null>(null);
  const menu = createDisclosure(false);
  const menuAt = createSignal({ x: 4, y: 1 });
  const popover = createDisclosure(false);
  return {
    title: 'Menus & overlays',
    stories: [
      {
        key: 'tooltip',
        name: 'Tooltip',
        controls: {
          open: { type: 'boolean', default: true },
        },
        view: (args) => (
          <VStack gap={1}>
            <Text id="tooltip-anchor">Save (anchor)</Text>
            <Tooltip
              text="Writes the buffer to disk"
              open={args.open === true}
              anchorId="tooltip-anchor"
            />
          </VStack>
        ),
      },
      {
        key: 'popover',
        name: 'Popover',
        view: () => (
          <VStack gap={1}>
            <Button
              id="popover-trigger"
              label={popover.open.get() ? 'Close popover' : 'Open popover'}
              onClick={() => popover.set(!popover.open.get())}
            />
            <Popover
              open={popover.open.get()}
              anchorId="popover-trigger"
              onDismiss={() => popover.set(false)}
            >
              <Text>Anchored beneath the trigger.</Text>
              <Text style={[styles.dim]}>esc dismisses</Text>
            </Popover>
          </VStack>
        ),
      },
      {
        key: 'menu-list',
        name: 'MenuList',
        view: () => {
          const items: MenuItem[] = [
            { kind: 'header', label: 'Models' },
            { key: 'fast', label: 'fast-1', detail: 'cheap' },
            { key: 'smart', label: 'smart-2', detail: 'slow' },
            { kind: 'separator' },
            { key: 'off', label: 'disabled', disabled: true },
          ];
          return <MenuList items={items} selectedKey="smart" />;
        },
      },
      {
        key: 'select',
        name: 'Select',
        view: () => (
          <VStack gap={1} width={26}>
            <Select
              id="gallery-select"
              value={model.get()}
              open={select.open.get()}
              onOpenChange={(next) => select.set(next)}
              onChange={(key) => model.set(key)}
              placeholder="Pick a model"
              options={[
                { key: 'fast', label: 'fast-1' },
                { key: 'smart', label: 'smart-2' },
              ]}
            />
            <Text style={[styles.muted]}>Click the trigger to open.</Text>
          </VStack>
        ),
      },
      {
        key: 'modal',
        name: 'Modal',
        view: () => (
          <VStack gap={1}>
            <Button label="Open modal" onClick={() => modal.set(true)} />
            <Text style={[styles.muted]}>Esc or the backdrop story text dims.</Text>
            {modal.open.get() ? (
              <Modal title="Confirm" onDismiss={() => modal.set(false)}>
                <Text>Delete this session?</Text>
                <Text style={[styles.dim]}>esc cancels</Text>
              </Modal>
            ) : null}
          </VStack>
        ),
      },
      {
        key: 'context-menu',
        name: 'ContextMenu',
        view: () => (
          <VStack
            gap={1}
            onMouse={(event) => {
              if (event.action === 'press') menuAt.set({ x: event.x, y: event.y });
              return false;
            }}
          >
            <Button label="Open menu" onClick={() => menu.set(true)} />
            {menu.open.get() ? (
              <ContextMenu
                at={menuAt.get()}
                items={[
                  { key: 'rename', label: 'Rename' },
                  { key: 'archive', label: 'Archive' },
                  { key: 'delete', label: 'Delete' },
                ]}
                onSelect={() => menu.set(false)}
                onDismiss={() => menu.set(false)}
              />
            ) : null}
          </VStack>
        ),
      },
    ],
  };
}
