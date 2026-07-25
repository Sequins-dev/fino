/** @jsxImportSource fino:ui */
import type { NormalizedChild, VNode } from 'fino:ui';

type Children = { children?: NormalizedChild[] };
type Tone = 'cyan' | 'amber' | 'coral' | 'ink';

const ink = '#0d1b1e';
const paper = '#f4f0e5';
const cyan = '#16b8c4';
const amber = '#f3aa18';
const coral = '#ee5b40';
const muted = '#66777a';

function toneColor(tone: Tone = 'cyan'): string {
  if (tone === 'amber') return amber;
  if (tone === 'coral') return coral;
  if (tone === 'ink') return ink;
  return cyan;
}

export function Eyebrow(props: Children): VNode {
  return <div style={{ color: coral, fontSize: '1em', fontWeight: 900, letterSpacing: '.22em', textTransform: 'uppercase', marginBottom: '.9em' }}>{props.children ?? []}</div>;
}

export function Lead(props: Children): VNode {
  return <div style={{ maxWidth: '30em', fontFamily: '"Iowan Old Style",Baskerville,serif', fontSize: '2.1em', lineHeight: 1.16, letterSpacing: '-.025em', color: ink }}>{props.children ?? []}</div>;
}

export function Rule(): VNode {
  return <div aria-hidden="true" style={{ width: '7em', height: '.45em', background: cyan, margin: '.35em 0 1.15em' }} />;
}

export function Grid(props: Children & { columns?: number }): VNode {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 2},minmax(0,1fr))`, gap: '1em', alignItems: 'stretch', width: '100%' }}>{props.children ?? []}</div>;
}

export function Panel(props: Children & { title: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ borderTop: `.45em solid ${color}`, background: '#ffffffa6', padding: '1.15em 1.3em', minWidth: 0, boxShadow: '0 1em 2.5em #0d1b1e12' }}>
    <div style={{ color, fontSize: '.72em', fontWeight: 900, letterSpacing: '.16em', textTransform: 'uppercase', marginBottom: '.65em' }}>{props.title}</div>
    <div style={{ display: 'grid', gap: '.5em', color: ink, fontSize: '1.2em', lineHeight: 1.35 }}>{props.children ?? []}</div>
  </div>;
}

export function Layer(props: Children & { label: string; detail: string; tone?: Tone; width?: string }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ display: 'grid', gridTemplateColumns: props.width ?? '12em 1fr', alignItems: 'center', minHeight: '6.2em', background: props.tone === 'ink' ? ink : '#fff9', borderLeft: `.7em solid ${color}`, color: props.tone === 'ink' ? paper : ink, padding: '1em 1.35em', width: '100%' }}>
    <div style={{ color, font: '900 .78em/1 "SFMono-Regular",monospace', letterSpacing: '.15em', textTransform: 'uppercase' }}>{props.label}</div>
    <div><div style={{ font: '800 1.5em/1.05 "Iowan Old Style",serif' }}>{props.children ?? []}</div><div style={{ color: props.tone === 'ink' ? '#b8c4c5' : muted, fontSize: '.9em', marginTop: '.45em' }}>{props.detail}</div></div>
  </div>;
}

export function Flow(props: Children): VNode {
  return <div style={{ display: 'flex', alignItems: 'stretch', gap: '.45em', width: '100%' }}>{props.children ?? []}</div>;
}

export function FlowNode(props: { number: string; title: string; detail: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ position: 'relative', flex: 1, minWidth: 0, background: ink, color: paper, padding: '1.15em 1em 1em', borderBottom: `.4em solid ${color}` }}>
    <div style={{ color, font: '900 .7em/1 "SFMono-Regular",monospace', letterSpacing: '.14em' }}>{props.number}</div>
    <div style={{ font: '800 1.35em/1.08 "Iowan Old Style",serif', margin: '.65em 0 .45em' }}>{props.title}</div>
    <div style={{ color: '#bdc8ca', fontSize: '.88em', lineHeight: 1.35 }}>{props.detail}</div>
  </div>;
}

export function Arrow(): VNode {
  return <div aria-hidden="true" style={{ alignSelf: 'center', color: coral, fontSize: '1.5em', fontWeight: 900 }}>→</div>;
}

export function Metric(props: { value: string; label: string; note?: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ background: ink, color: paper, padding: '1.2em', minHeight: '9em', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderBottom: `.4em solid ${color}` }}>
    <div style={{ color, font: '800 4em/.9 "Iowan Old Style",serif', letterSpacing: '-.055em' }}>{props.value}</div>
    <div><div style={{ fontSize: '1.05em', fontWeight: 900 }}>{props.label}</div>{props.note ? <div style={{ color: '#aebbbc', fontSize: '.78em', marginTop: '.3em', lineHeight: 1.3 }}>{props.note}</div> : null}</div>
  </div>;
}

export function Evidence(props: { value: string; title: string; before: string; after: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ display: 'grid', gridTemplateColumns: '10em 1fr', gap: '1.1em', alignItems: 'center', background: ink, color: paper, padding: '1.15em 1.3em', borderLeft: `.55em solid ${color}` }}>
    <div style={{ color, font: '800 3em/.9 "Iowan Old Style",serif', letterSpacing: '-.05em' }}>{props.value}</div>
    <div><div style={{ fontSize: '1.15em', fontWeight: 900 }}>{props.title}</div><div style={{ color: '#afbdbe', fontSize: '.82em', lineHeight: 1.35, marginTop: '.35em' }}><span style={{ color: coral }}>{props.before}</span> → <span style={{ color: cyan }}>{props.after}</span></div></div>
  </div>;
}

export function Callout(props: Children & { label: string; tone?: Tone }): VNode {
  const background = props.tone === undefined || props.tone === 'amber' ? '#d88a00' : toneColor(props.tone);
  const foreground = props.tone === 'ink' ? paper : ink;
  return <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1em', alignItems: 'center', background, color: foreground, padding: '1em 1.25em' }}><div style={{ font: '900 .66em/1 "SFMono-Regular",monospace', letterSpacing: '.12em', textTransform: 'uppercase' }}>{props.label}</div><div style={{ fontFamily: '"Avenir Next","Helvetica Neue",sans-serif', fontSize: '1.15em', fontWeight: 600, lineHeight: 1.3, letterSpacing: '.005em' }}>{props.children ?? []}</div></div>;
}

export function CodeLabel(props: Children): VNode {
  return <div style={{ color: cyan, background: ink, padding: '.55em .8em', width: 'fit-content', font: '900 .65em/1 "SFMono-Regular",monospace', letterSpacing: '.12em', textTransform: 'uppercase' }}>{props.children ?? []}</div>;
}

export function Decision(props: { when: string; choose: string; reason: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr', gap: '.8em', borderTop: `.125em solid ${color}`, padding: '.75em .1em', fontSize: '1em', lineHeight: 1.3 }}><div style={{ color: muted }}>{props.when}</div><div style={{ color, fontWeight: 900 }}>{props.choose}</div><div>{props.reason}</div></div>;
}
