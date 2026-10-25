/**
 * Terminal USSD simulator. Talks to a running server exactly like Africa's Talking would
 * (form-encoded POST, cumulative "text").
 *
 *   npm run ussd:sim -- --phone +254700000999 [--url http://localhost:4000/api/ussd] [--code *123#]
 */
import readline from 'node:readline/promises';
import crypto from 'node:crypto';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const url = arg('url', process.env.USSD_URL ?? 'http://localhost:4000/api/ussd');
const phone = arg('phone', '+254700000999');
const serviceCode = arg('code', process.env.AFRICASTALKING_USSD_SERVICE_CODE ?? '*123#');
const sessionId = `CLI-${crypto.randomUUID()}`;
const inputs: string[] = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`Dialing ${serviceCode} as ${phone} (session ${sessionId})\n`);
for (;;) {
  const body = new URLSearchParams({ sessionId, serviceCode, phoneNumber: phone, networkCode: '99999', text: inputs.join('*') });
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const text = await res.text();
  console.log('┌──────────────────────────────');
  for (const line of text.slice(4).split('\n')) console.log(`│ ${line}`);
  console.log(`└── ${text.slice(0, 3)} · ${text.length - 4} chars\n`);
  if (!text.startsWith('CON')) break;
  inputs.push(await rl.question('> '));
}
rl.close();
