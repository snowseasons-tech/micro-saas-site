import store from '../../api/_lib/store.js';
import mail from '../../api/_lib/mail.js';
import { send, methodNotAllowed, clientIp } from '../_lib/http.js';
import { useEnv, storeConfigured } from '../_lib/env.js';

const PER_IP_PER_HOUR = 5;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,}$/;
// Field -> max length. Anything else in the body is ignored.
const LIMITS = { name: 100, email: 254, company: 120, service: 60, budget: 40, timeline: 40, message: 5000 };

export const onRequest = methodNotAllowed('POST');

// Project inquiries from the homepage form, emailed to CONTACT_TO with Reply-To set to the sender.
// Nothing is emailed to the sender, so the form can't be used to send mail to arbitrary addresses.
export async function onRequestPost({ request, env }) {
  useEnv(env);
  let body;
  try { body = JSON.parse((await request.text()) || '{}'); } catch { return send(400, { error: 'Bad JSON' }); }
  if (!body || typeof body !== 'object') return send(400, { error: 'Bad JSON' });
  // Honeypot: real visitors never see the "website" field. Pretend success so bots don't retry.
  if (body.website) return send(200, { sent: true });

  const f = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    f[k] = String(body[k] ?? '').trim();
    if (f[k].length > max) return send(400, { error: `${k} is too long` });
  }
  if (!f.name) return send(400, { error: 'Please enter your name' });
  if (!EMAIL_RE.test(f.email)) return send(400, { error: 'Please enter a valid email address' });
  if (f.message.length < 10) return send(400, { error: 'Please tell us a little about the project' });
  if (!env.CONTACT_TO) return send(503, { error: 'The form is not set up yet. Please email us instead.' });

  try {
    if (storeConfigured(env) && (await store.incr(`contact:${clientIp(request)}`, 3600)) > PER_IP_PER_HOUR) {
      return send(429, { error: 'Too many messages. Please try again later or email us.' });
    }
    const oneLine = (s) => s.replace(/[\r\n]+/g, ' ');
    const sent = await mail.sendMail({
      to: env.CONTACT_TO,
      replyTo: f.email,
      subject: `Project inquiry: ${oneLine(f.name)}${f.company ? ` (${oneLine(f.company)})` : ''}`,
      text: [
        `Name: ${f.name}`, `Email: ${f.email}`, `Company: ${f.company || '-'}`,
        `Service: ${f.service || '-'}`, `Budget: ${f.budget || '-'}`, `Timeline: ${f.timeline || '-'}`,
        '', f.message,
      ].join('\n'),
    });
    if (sent !== 'sent') return send(503, { error: 'The form is not set up yet. Please email us instead.' });
    return send(200, { sent: true });
  } catch (e) {
    console.error('contact', e.message);
    return send(500, { error: 'Could not send your message. Please email us instead.' });
  }
}
