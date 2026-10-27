import { json } from '../src/http.js';

export function GET(): Response {
  return json({ ok: true, time: new Date().toISOString() });
}
