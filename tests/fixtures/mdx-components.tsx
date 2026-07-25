export function Callout(props: {
  tone: string;
  children?: unknown[];
}) {
  return <aside data-tone={props.tone}>{props.children}</aside>;
}
