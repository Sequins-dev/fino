import { topic } from 'fino:context/topic';

console.log('hello from simulation');
topic('otel:sim:guest').publish({ value: 42 });

export default function diagnosticsGuest(): string {
  return 'done';
}
