/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/disclosure.stories — gallery stories for expanders, details, accordions, and tabs.
 *
 * Lives beside the components it demonstrates so the two stay in step;
 * `fino:ui/gallery` composes every group into the browsable catalog.
 *
 * @internal
 */
import { createSignal } from 'fino:ui';
import {
  Accordion,
  Details,
  Expander,
  HStack,
  Tabs,
  Text,
  VStack,
  createAccordion,
  createDisclosure,
  styles,
} from 'fino:ui/components';
import type { ExpanderPosition } from 'fino:ui/components';
import type { StoryGroup } from 'internal:ui/story';

export function disclosureStories(): StoryGroup {
  const details = createDisclosure(true);
  const tab = createSignal('one');
  const expanded = createSignal(false);
  const accordionSingle = createAccordion(true);
  const accordionMulti = createAccordion();
  return {
    title: 'Disclosure',
    stories: [
      {
        key: 'expander',
        name: 'Expander',
        view: () => (
          <VStack gap={1}>
            <HStack gap={1}>
              <Expander open={expanded.get()} onToggle={(next) => expanded.set(next)} />
              <Text>marker before the label</Text>
            </HStack>
            <HStack gap={1}>
              <Text>marker after the label</Text>
              <Expander open={expanded.get()} onToggle={(next) => expanded.set(next)} />
            </HStack>
            <Text style={[styles.muted]}>{expanded.get() ? 'open' : 'closed'}</Text>
          </VStack>
        ),
      },
      {
        key: 'accordion',
        name: 'Accordion',
        controls: {
          single: { type: 'boolean', default: true },
        },
        view: (args) => {
          const state = args.single === true ? accordionSingle : accordionMulti;
          return (
            <Accordion
              id="gallery-accordion"
              sections={[
                { key: 'general', title: 'General', content: <Text>Session defaults.</Text> },
                { key: 'network', title: 'Network', content: <Text>Proxy and TLS.</Text> },
                {
                  key: 'advanced',
                  title: 'Advanced',
                  content: <Text style={[styles.muted]}>Debug flags.</Text>,
                },
              ]}
              openKeys={state.openKeys.get()}
              onToggle={state.toggle}
            />
          );
        },
      },
      {
        key: 'details',
        name: 'Details',
        controls: {
          expander: { type: 'select', options: ['start', 'end', 'none'], default: 'start' },
        },
        view: (args) => (
          <Details
            title="Advanced options"
            open={details.open.get()}
            expander={args.expander as ExpanderPosition}
            onToggle={(next) => details.set(next)}
          >
            <Text>Hidden until expanded.</Text>
            <Text style={[styles.muted]}>Click the summary bar to toggle.</Text>
          </Details>
        ),
      },
      {
        key: 'tabs',
        name: 'Tabs',
        view: () => (
          <Tabs
            value={tab.get()}
            onChange={(key) => tab.set(key)}
            items={[
              { key: 'one', label: 'Overview' },
              { key: 'two', label: 'Details' },
              { key: 'three', label: 'Raw' },
            ]}
          >
            <Text>{`Active panel: ${tab.get()}`}</Text>
          </Tabs>
        ),
      },
    ],
  };
}
