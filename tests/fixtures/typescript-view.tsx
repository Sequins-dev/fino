export function Greeting(props: { name: string }) {
  return <h1 class="greeting">Hello, {props.name}</h1>;
}

export const greeting = Greeting({ name: 'Fino' });
