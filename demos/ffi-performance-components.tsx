/** @jsxImportSource fino:ui */
import type { NormalizedChild, VNode } from 'fino:ui';

type Children = { children?: NormalizedChild[] };

const ink = '#111923';
const paper = '#f3efe4';
const cyan = '#20c5d8';
const amber = '#ffb000';
const coral = '#f05d44';
const muted = '#76818b';

export function Eyebrow(props: Children): VNode {
  return <div style={{ color: coral, fontSize: 'clamp(.68rem,1cqw,1rem)', fontWeight: 800, letterSpacing: '.22em', textTransform: 'uppercase', marginBottom: '.9rem' }}>{props.children ?? []}</div>;
}

export function Lead(props: Children): VNode {
  return <div style={{ maxWidth: '29em', fontFamily: '"Iowan Old Style",Baskerville,serif', fontSize: 'clamp(1.35rem,2.6cqw,2.7rem)', lineHeight: 1.18, letterSpacing: '-.02em', color: ink }}>{props.children ?? []}</div>;
}

export function Rule(): VNode {
  return <div aria-hidden="true" style={{ width: '7rem', height: '.45rem', background: cyan, margin: '.3rem 0 1.1rem' }} />;
}

export function Panel(props: Children & { title: string; tone?: 'cyan' | 'amber' | 'coral' | 'ink' }): VNode {
  const color = props.tone === 'amber' ? amber : props.tone === 'coral' ? coral : props.tone === 'ink' ? ink : cyan;
  return <div style={{ borderTop: `.45rem solid ${color}`, background: '#ffffff9c', padding: '1.25rem 1.35rem', minWidth: 0, boxShadow: '0 1rem 2.5rem #11192312' }}>
    <div style={{ color, fontSize: '.72rem', fontWeight: 900, letterSpacing: '.16em', textTransform: 'uppercase', marginBottom: '.7rem' }}>{props.title}</div>
    <div style={{ display: 'grid', gap: '.55rem', color: ink, fontSize: 'clamp(.86rem,1.35cqw,1.35rem)', lineHeight: 1.35 }}>{props.children ?? []}</div>
  </div>;
}

export function Grid(props: Children & { columns?: number }): VNode {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${props.columns ?? 2},minmax(0,1fr))`, gap: '1rem', alignItems: 'stretch', width: '100%' }}>{props.children ?? []}</div>;
}

export function Flow(props: Children): VNode {
  return <div style={{ display: 'flex', alignItems: 'stretch', gap: '.45rem', width: '100%' }}>{props.children ?? []}</div>;
}

export function FlowNode(props: { number: string; title: string; detail: string; tone?: 'cyan' | 'amber' | 'coral' }): VNode {
  const color = props.tone === 'amber' ? amber : props.tone === 'coral' ? coral : cyan;
  return <div style={{ position: 'relative', flex: 1, minWidth: 0, background: ink, color: paper, padding: '1.2rem 1rem 1rem', borderBottom: `.35rem solid ${color}` }}>
    <div style={{ color, font: '800 .7rem/1 "SFMono-Regular",monospace', letterSpacing: '.14em' }}>{props.number}</div>
    <div style={{ font: '700 clamp(.9rem,1.55cqw,1.45rem)/1.1 "Avenir Next Condensed",sans-serif', margin: '.65rem 0 .45rem' }}>{props.title}</div>
    <div style={{ color: '#c8d0d4', fontSize: 'clamp(.65rem,1cqw,1rem)', lineHeight: 1.35 }}>{props.detail}</div>
  </div>;
}

export function Arrow(): VNode {
  return <div aria-hidden="true" style={{ alignSelf: 'center', color: coral, fontSize: '1.5rem', fontWeight: 900 }}>→</div>;
}

export function Tier(props: { name: string; route: string; cost: string; eligibility: string; tone?: 'cyan' | 'amber' | 'coral' }): VNode {
  const color = props.tone === 'amber' ? amber : props.tone === 'coral' ? coral : cyan;
  return <div style={{ display: 'grid', gridTemplateColumns: '1.05fr 1.35fr .7fr', gap: '1rem', alignItems: 'center', borderLeft: `.4rem solid ${color}`, background: '#fff9', padding: '1rem 1.2rem' }}>
    <div><div style={{ color, fontSize: '.68rem', fontWeight: 900, letterSpacing: '.14em', textTransform: 'uppercase' }}>{props.name}</div><div style={{ fontSize: 'clamp(.86rem,1.35cqw,1.35rem)', fontWeight: 800 }}>{props.route}</div></div>
    <div style={{ color: muted, fontSize: 'clamp(.72rem,1.05cqw,1.05rem)', lineHeight: 1.35 }}>{props.eligibility}</div>
    <div style={{ justifySelf: 'end', color: ink, font: '800 clamp(.82rem,1.15cqw,1.15rem)/1 "SFMono-Regular",monospace' }}>{props.cost}</div>
  </div>;
}

export function MatrixRow(props: { type: string; parameter: string; result: string; note: string; tone?: 'cyan' | 'amber' | 'coral' }): VNode {
  const color = props.tone === 'amber' ? amber : props.tone === 'coral' ? coral : cyan;
  return <div style={{ display: 'grid', gridTemplateColumns: '1.15fr .75fr .75fr 1.8fr', gap: '.7rem', alignItems: 'center', borderBottom: '1px solid #11192322', padding: '.58rem .25rem', fontSize: 'clamp(.67rem,1cqw,1rem)' }}>
    <div style={{ fontFamily: '"SFMono-Regular",monospace', fontWeight: 800 }}>{props.type}</div>
    <div style={{ color, fontWeight: 900 }}>{props.parameter}</div>
    <div style={{ color, fontWeight: 900 }}>{props.result}</div>
    <div style={{ color: muted }}>{props.note}</div>
  </div>;
}

export function MatrixHeader(): VNode {
  return <div style={{ display: 'grid', gridTemplateColumns: '1.15fr .75fr .75fr 1.8fr', gap: '.7rem', padding: '.45rem .25rem', color: coral, fontSize: '.62rem', fontWeight: 900, letterSpacing: '.13em', textTransform: 'uppercase' }}><span>ABI shape</span><span>Fast param</span><span>Fast return</span><span>Why</span></div>;
}

export function PointerWord(): VNode {
  const bytes = ['A₀', 'A₁', 'A₂', 'A₃', 'A₄', 'A₅', 'A₆', 'A₇'];
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8,1fr)', gap: '.28rem', width: '100%', maxWidth: '42rem' }}>{bytes.map((byte, index) => <div key={byte} style={{ aspectRatio: '1', display: 'grid', placeItems: 'center', background: index < 4 ? cyan : amber, color: ink, font: '800 clamp(.7rem,1.3cqw,1.25rem)/1 "SFMono-Regular",monospace', boxShadow: 'inset 0 0 0 1px #11192344' }}>{byte}</div>)}</div>;
}

export function Metric(props: { value: string; label: string; note?: string; tone?: 'cyan' | 'amber' | 'coral' }): VNode {
  const color = props.tone === 'amber' ? amber : props.tone === 'coral' ? coral : cyan;
  return <div style={{ background: ink, color: paper, padding: '1.25rem', minHeight: '9rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
    <div style={{ color, font: '800 clamp(1.9rem,4cqw,4.2rem)/.9 "Iowan Old Style",serif', letterSpacing: '-.05em' }}>{props.value}</div>
    <div><div style={{ fontSize: 'clamp(.8rem,1.2cqw,1.15rem)', fontWeight: 800 }}>{props.label}</div>{props.note ? <div style={{ color: '#aeb8be', fontSize: 'clamp(.62rem,.9cqw,.9rem)', marginTop: '.3rem' }}>{props.note}</div> : null}</div>
  </div>;
}

export function Callout(props: Children & { label: string }): VNode {
  return <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1rem', alignItems: 'center', background: amber, color: ink, padding: '1rem 1.25rem' }}><div style={{ font: '900 .66rem/1 "SFMono-Regular",monospace', letterSpacing: '.12em', textTransform: 'uppercase' }}>{props.label}</div><div style={{ fontSize: 'clamp(.9rem,1.4cqw,1.4rem)', fontWeight: 700 }}>{props.children ?? []}</div></div>;
}

export function CodeLabel(props: Children): VNode {
  return <div style={{ color: cyan, background: ink, padding: '.55rem .8rem', width: 'fit-content', font: '800 .65rem/1 "SFMono-Regular",monospace', letterSpacing: '.12em', textTransform: 'uppercase' }}>{props.children ?? []}</div>;
}

export function Decision(props: { when: string; choose: string; reason: string; tone?: 'cyan' | 'amber' | 'coral' }): VNode {
  const color = props.tone === 'amber' ? amber : props.tone === 'coral' ? coral : cyan;
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.45fr', gap: '.8rem', borderTop: `2px solid ${color}`, padding: '.75rem .1rem', fontSize: 'clamp(.7rem,1.05cqw,1.05rem)' }}><div style={{ color: muted }}>{props.when}</div><div style={{ color, fontWeight: 900 }}>{props.choose}</div><div>{props.reason}</div></div>;
}
