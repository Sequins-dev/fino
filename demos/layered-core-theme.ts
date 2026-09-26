/** Deck-specific presentation styling over the shared UI component catalog. */
export const styles = `
.fino-slide-frame {
  font-family: "Avenir Next", "Helvetica Neue", sans-serif;
  color-scheme: dark;
}
.fino-slide-frame:before {
  background: none;
  opacity: 1;
  inset: 0 auto 0 0;
  width: .5em;
  background: var(--slides-accent);
}
.fino-slide-frame h1,
.fino-slide-frame h2 {
  font-family: "Iowan Old Style", "Baskerville", serif;
  font-weight: 600;
  letter-spacing: -.045em;
  line-height: 1.08;
}
.fino-slide-frame h1 { font-size: 6.5cqw; max-width: 14ch; }
.fino-slide-frame h2 { font-size: 4cqw; }
.fino-slide-frame .ui-lead {
  font-family: Georgia, serif;
  font-size: 2em;
  line-height: 1.18;
  max-width: 26em;
  margin: 0;
}
.fino-slide-frame .ui-caption {
  font-size: 1.15em;
  line-height: 1.3;
  color: #b8bfc1;
}
.fino-slide-frame .reuse-loop-frame {
  --reuse-loop-color: color-mix(in srgb, var(--slides-ink) 58%, transparent);
  --reuse-loop-stroke: .1em;
  position: relative;
  flex: 0 0 auto;
  margin: .15em 1.25em .1em .35em;
  padding: 0 0 0 1.9em;
  font-family: Georgia, serif;
  font-size: 2.5cqw;
  line-height: 1.2;
}
.fino-slide-frame .reuse-loop-frame .ui-timeline {
  margin: 0;
  padding: 0;
  font-size: 1em;
}
.fino-slide-frame .reuse-loop-frame .ui-timeline li {
  color: var(--slides-ink);
  font-size: 1em;
  min-height: 1.9em;
  padding: 0 0 .85em 1.55em;
}
.fino-slide-frame .reuse-loop-frame .ui-timeline li::before {
  top: .28em;
  width: .58em;
  height: .58em;
  box-shadow: 0 0 0 .16em var(--slides-paper), 0 0 0 .21em currentColor;
}
.fino-slide-frame .reuse-loop-frame .ui-timeline li:not(:last-child)::after {
  left: .27em;
  top: .95em;
  bottom: -.05em;
  border-left: var(--reuse-loop-stroke) solid var(--reuse-loop-color);
}
.fino-slide-frame .reuse-loop-return {
  position: absolute;
  top: .57em;
  left: .1em;
  bottom: 1.48em;
  width: 1.8em;
  border: var(--reuse-loop-stroke) solid var(--reuse-loop-color);
  border-right: 0;
  border-radius: .7em 0 0 .7em;
  pointer-events: none;
}
.fino-slide-frame .reuse-loop-arrow {
  position: absolute;
  top: 50%;
  left: calc(var(--reuse-loop-stroke) * -2.8);
  width: 0;
  height: 0;
  border-right: .28em solid transparent;
  border-bottom: .45em solid var(--reuse-loop-color);
  border-left: .28em solid transparent;
  transform: translateY(-50%);
}
.fino-slide-frame .reuse-loop-frame .ui-timeline-title {
  color: var(--slides-ink);
  max-width: 31em;
}
.fino-slide-frame .ui-callout {
  --deck-callout-accent: var(--slides-accent);
  min-height: 4.7em;
  padding: .7em 1em;
  border-left-width: .22em;
  border-radius: .35em;
  background: #252a2e;
  color: var(--slides-ink);
  box-shadow: inset 0 0 0 1px #ffffff0d;
  font-size: 1.25em;
  line-height: 1.2;
}
.fino-slide-frame .ui-callout.is-muted { --deck-callout-accent: var(--tui-bright-black); }
.fino-slide-frame .ui-callout.is-danger { --deck-callout-accent: var(--tui-red); }
.fino-slide-frame .ui-callout.is-success { --deck-callout-accent: var(--tui-green); }
.fino-slide-frame .ui-callout.is-warning { --deck-callout-accent: var(--tui-yellow); }
.fino-slide-frame .ui-callout:has(.ui-callout-title) {
  display: grid;
  grid-template-columns: 9em 1fr;
  align-items: center;
}
.fino-slide-frame .ui-callout-title {
  color: var(--slides-accent);
  font-size: .85em;
  font-weight: 600;
}
.fino-slide-frame .ui-callout:not(:has(.ui-callout-title)) {
  min-height: 0;
  border-left: 0;
  border-top: .12em solid var(--deck-callout-accent);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-family: Georgia, serif;
  font-size: 1.8em;
  padding: .8em 0 0;
}
.fino-slide-frame .ui-code { margin: 0; }
.fino-slide-frame .ui-code-line { display: block; min-height: 1.3em; }
.fino-slide-frame .ui-code-content { white-space: pre; }
.fino-slide-frame pre {
  font-size: 1.6em;
  line-height: 1.3;
  padding: 1em 1.15em;
  margin: 0;
  overflow: visible;
  background: #202529;
  color: var(--slides-ink);
  border: 1px solid #ffffff14;
  border-radius: .35em;
  box-shadow: 0 .4em 1em #00000018;
}
.fino-slide-frame pre code { background: none; padding: 0; font-size: inherit; }
.fino-slide-frame table {
  width: 100%;
  border-collapse: collapse;
  font-size: 1.5em;
  line-height: 1.3;
}
.fino-slide-frame th {
  text-align: left;
  color: var(--slides-accent);
  border-bottom: 2px solid #83908f;
  padding: .35em .5em;
}
.fino-slide-frame td {
  padding: .5em;
  border-bottom: 1px solid #ffffff20;
  vertical-align: top;
}
.fino-slide-frame tbody tr:nth-child(odd) { background: #ffffff04; }
.fino-slide-frame .fino-progress { height: .16em; background: #ffffff10; }
`;
