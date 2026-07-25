import { generate } from 'app:model';
export default async function modelFacadeCall(): Promise<string> {
  const result = await generate({ messages: [{
    role: 'user',
    content: 'hi'
  }] }) as {
    text: string;
  };
  return result.text;
}
