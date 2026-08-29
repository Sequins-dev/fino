/**
 * fino:ui/preview — run one component-preview catalog in terminals and browsers.
 *
 * Component families own target-neutral preview descriptors beside their
 * implementations. This module composes those descriptors once, then passes
 * the same VNode-producing views to the retained terminal renderer or the
 * server-driven HTML renderer.
 *
 * ```ts no_run
 * import { runPreviewTui } from 'fino:ui/preview';
 * await runPreviewTui();
 * ```
 *
 * ```ts no_run
 * import { runPreviewHtml } from 'fino:ui/preview';
 * await using server = runPreviewHtml({ port: 3080 });
 * await server.ready;
 * ```
 */
import type { ServeServer } from 'fino:net/http/server';
import type { App } from 'fino:net/http/app';
import { defaultArgs, parseArgs, validatePreviewGroups } from 'internal:ui/preview';
import type {
  Control,
  ControlValue,
  Preview,
  PreviewArgs,
  PreviewGroup,
} from 'internal:ui/preview';
import { runPreviewTui as runTui } from 'internal:ui/preview-tui';
import {
  createPreviewApp as createApp,
  previewPage as renderPage,
  runPreviewHtml as runHtml,
} from 'internal:ui/preview-html';
import { layoutPreviews } from 'internal:ui/components/layout.preview';
import { typographyPreviews } from 'internal:ui/components/typography.preview';
import { iconPreviews } from 'internal:ui/components/icons.preview';
import { formsPreviews } from 'internal:ui/components/forms.preview';
import { disclosurePreviews } from 'internal:ui/components/disclosure.preview';
import { menuPreviews } from 'internal:ui/components/menu.preview';
import { navigationPreviews } from 'internal:ui/components/navigation.preview';
import { overlayPreviews } from 'internal:ui/components/overlay.preview';
import { feedbackPreviews } from 'internal:ui/components/feedback.preview';
import { displayPreviews } from 'internal:ui/components/display.preview';
import { dataPreviews } from 'internal:ui/components/data.preview';
import { virtualPreviews } from 'internal:ui/components/virtual.preview';
import { pickersPreviews } from 'internal:ui/components/pickers.preview';
import { chartsPreviews } from 'internal:ui/components/charts.preview';

export { defaultArgs, parseArgs };
export type { Control, ControlValue, Preview, PreviewArgs, PreviewGroup };

/** Build the complete built-in component catalog in display order. */
export function catalogPreviews(): PreviewGroup[] {
  return validatePreviewGroups([
    layoutPreviews(),
    typographyPreviews(),
    iconPreviews(),
    formsPreviews(),
    disclosurePreviews(),
    menuPreviews(),
    navigationPreviews(),
    overlayPreviews(),
    feedbackPreviews(),
    displayPreviews(),
    dataPreviews(),
    virtualPreviews(),
    pickersPreviews(),
    chartsPreviews(),
  ]);
}

/** Run a preview catalog as a live fullscreen terminal application. */
export function runPreviewTui(groups: PreviewGroup[] = catalogPreviews()): Promise<void> {
  return runTui(validatePreviewGroups(groups));
}

/** Render a complete static HTML page for one selected preview. */
export function previewPage(
  groups: PreviewGroup[],
  selectedKey: string | null,
  rawArgs: Record<string, string> = {},
  actions?: Map<string, (value?: string) => void>,
): string {
  return renderPage(validatePreviewGroups(groups), selectedKey, rawArgs, actions);
}

/** Build the live server-driven preview application without opening a listener. */
export function createPreviewApp(groups: PreviewGroup[] = catalogPreviews()): App {
  return createApp(validatePreviewGroups(groups));
}

/** Listen for the live browser preview on localhost by default. */
export function runPreviewHtml(
  options: { port?: number; hostname?: string; groups?: PreviewGroup[] } = {},
): ServeServer {
  return runHtml({
    ...options,
    groups: validatePreviewGroups(options.groups ?? catalogPreviews()),
  });
}
