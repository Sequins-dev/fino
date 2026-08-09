/** @jsxImportSource fino:ui */
export default function Page(props: { site: string; title: string }) {
  return (
    <main>
      {props.site} / {props.title}
    </main>
  );
}
