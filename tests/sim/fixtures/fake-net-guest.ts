export default async function (): Promise<unknown> {
  const health = await fetch('https://api.example.com/health');
  const created = await fetch('https://api.example.com/orders', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-request-id': 'req-1' },
    body: 'one widget',
  });
  const missing = await fetch('https://api.example.com/missing');

  return {
    health: {
      status: health.status,
      body: await health.text(),
      source: health.headers.get('x-source'),
    },
    created: {
      status: created.status,
      body: await created.text(),
      location: created.headers.get('location'),
    },
    missing: {
      status: missing.status,
      body: await missing.text(),
    },
  };
}
