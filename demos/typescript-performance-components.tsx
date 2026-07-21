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
  return <div style={{ color: coral, fontSize: '1rem', fontWeight: 900, letterSpacing: '.22em', textTransform: 'uppercase', marginBottom: '.9rem' }}>{props.children ?? []}</div>;
}

export function Lead(props: Children): VNode {
  return <div style={{ maxWidth: '30em', fontFamily: '"Iowan Old Style",Baskerville,serif', fontSize: '2.55rem', lineHeight: 1.16, letterSpacing: '-.025em', color: ink }}>{props.children ?? []}</div>;
}

export function Rule(): VNode {
  return <div aria-hidden="true" style={{ width: '7rem', height: '.45rem', background: cyan, margin: '.35rem 0 1.15rem' }} />;
}

export function Grid(props: Children & { columns?: number }): VNode {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 2},minmax(0,1fr))`, gap: '1rem', alignItems: 'stretch', width: '100%' }}>{props.children ?? []}</div>;
}

export function Panel(props: Children & { title: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ borderTop: `.45rem solid ${color}`, background: '#ffffffa6', padding: '1.15rem 1.3rem', minWidth: 0, boxShadow: '0 1rem 2.5rem #0d1b1e12' }}>
    <div style={{ color, fontSize: '.72rem', fontWeight: 900, letterSpacing: '.16em', textTransform: 'uppercase', marginBottom: '.65rem' }}>{props.title}</div>
    <div style={{ display: 'grid', gap: '.5rem', color: ink, fontSize: '1.2rem', lineHeight: 1.35 }}>{props.children ?? []}</div>
  </div>;
}

export function Layer(props: Children & { label: string; detail: string; tone?: Tone; width?: string }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ display: 'grid', gridTemplateColumns: props.width ?? '12rem 1fr', alignItems: 'center', minHeight: '6.2rem', background: props.tone === 'ink' ? ink : '#fff9', borderLeft: `.7rem solid ${color}`, color: props.tone === 'ink' ? paper : ink, padding: '1rem 1.35rem', width: '100%' }}>
    <div style={{ color, font: '900 .78rem/1 "SFMono-Regular",monospace', letterSpacing: '.15em', textTransform: 'uppercase' }}>{props.label}</div>
    <div><div style={{ font: '800 1.5rem/1.05 "Iowan Old Style",serif' }}>{props.children ?? []}</div><div style={{ color: props.tone === 'ink' ? '#b8c4c5' : muted, fontSize: '.9rem', marginTop: '.45rem' }}>{props.detail}</div></div>
  </div>;
}

export function Flow(props: Children): VNode {
  return <div style={{ display: 'flex', alignItems: 'stretch', gap: '.45rem', width: '100%' }}>{props.children ?? []}</div>;
}

export function FlowNode(props: { number: string; title: string; detail: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ position: 'relative', flex: 1, minWidth: 0, background: ink, color: paper, padding: '1.15rem 1rem 1rem', borderBottom: `.4rem solid ${color}` }}>
    <div style={{ color, font: '900 .7rem/1 "SFMono-Regular",monospace', letterSpacing: '.14em' }}>{props.number}</div>
    <div style={{ font: '800 1.35rem/1.08 "Iowan Old Style",serif', margin: '.65rem 0 .45rem' }}>{props.title}</div>
    <div style={{ color: '#bdc8ca', fontSize: '.88rem', lineHeight: 1.35 }}>{props.detail}</div>
  </div>;
}

export function Arrow(): VNode {
  return <div aria-hidden="true" style={{ alignSelf: 'center', color: coral, fontSize: '1.5rem', fontWeight: 900 }}>→</div>;
}

export function Metric(props: { value: string; label: string; note?: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ background: ink, color: paper, padding: '1.2rem', minHeight: '9rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderBottom: `.4rem solid ${color}` }}>
    <div style={{ color, font: '800 4rem/.9 "Iowan Old Style",serif', letterSpacing: '-.055em' }}>{props.value}</div>
    <div><div style={{ fontSize: '1.05rem', fontWeight: 900 }}>{props.label}</div>{props.note ? <div style={{ color: '#aebbbc', fontSize: '.78rem', marginTop: '.3rem', lineHeight: 1.3 }}>{props.note}</div> : null}</div>
  </div>;
}

export function Evidence(props: { value: string; title: string; before: string; after: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ display: 'grid', gridTemplateColumns: '10rem 1fr', gap: '1.1rem', alignItems: 'center', background: ink, color: paper, padding: '1.15rem 1.3rem', borderLeft: `.55rem solid ${color}` }}>
    <div style={{ color, font: '800 3rem/.9 "Iowan Old Style",serif', letterSpacing: '-.05em' }}>{props.value}</div>
    <div><div style={{ fontSize: '1.15rem', fontWeight: 900 }}>{props.title}</div><div style={{ color: '#afbdbe', fontSize: '.82rem', lineHeight: 1.35, marginTop: '.35rem' }}><span style={{ color: coral }}>{props.before}</span> → <span style={{ color: cyan }}>{props.after}</span></div></div>
  </div>;
}

export function Callout(props: Children & { label: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone ?? 'amber');
  return <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1rem', alignItems: 'center', background: color, color: ink, padding: '1rem 1.25rem' }}><div style={{ font: '900 .66rem/1 "SFMono-Regular",monospace', letterSpacing: '.12em', textTransform: 'uppercase' }}>{props.label}</div><div style={{ fontSize: '1.25rem', fontWeight: 800 }}>{props.children ?? []}</div></div>;
}

export function CodeLabel(props: Children): VNode {
  return <div style={{ color: cyan, background: ink, padding: '.55rem .8rem', width: 'fit-content', font: '900 .65rem/1 "SFMono-Regular",monospace', letterSpacing: '.12em', textTransform: 'uppercase' }}>{props.children ?? []}</div>;
}

export function Decision(props: { when: string; choose: string; reason: string; tone?: Tone }): VNode {
  const color = toneColor(props.tone);
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr', gap: '.8rem', borderTop: `2px solid ${color}`, padding: '.75rem .1rem', fontSize: '1rem', lineHeight: 1.3 }}><div style={{ color: muted }}>{props.when}</div><div style={{ color, fontWeight: 900 }}>{props.choose}</div><div>{props.reason}</div></div>;
}
