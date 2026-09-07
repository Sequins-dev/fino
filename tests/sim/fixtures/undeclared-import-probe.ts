/** Probe modules that must stay unavailable unless the simulation world declares them. */
export default async function probe(): Promise<string[]> {
  const reached: string[] = [];
  try {
    await import('fino:file');
    reached.push('fino:file');
  } catch {}
  try {
    await import('fino:process');
    reached.push('fino:process');
  } catch {}
  try {
    await import('fino:realm');
    reached.push('fino:realm');
  } catch {}
  return reached;
}
