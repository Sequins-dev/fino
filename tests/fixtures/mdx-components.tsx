export function Callout(props: { tone: string; children?: unknown[] }) {
  return <aside data-tone={props.tone}>{props.children}</aside>;
}

export function Badge(props: { children?: unknown[] }) {
  return <span data-badge>{props.children}</span>;
}
