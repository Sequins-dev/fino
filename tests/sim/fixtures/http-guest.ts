/** A guest that uses ambient fetch, which a simulation answers from a route table. */
export default async function main(): Promise<{ health: string; missing: number }> {
  const ok = await fetch('https://api.example.com/health');
  const health = await ok.text();
  const bad = await fetch('https://api.example.com/nowhere');
  return { health, missing: bad.status };
}
