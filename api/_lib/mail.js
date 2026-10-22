// Transactional email via Resend's REST API (no dependency). Skips cleanly if not configured.
// replyTo (optional) lets a reply go straight to someone other than MAIL_FROM, e.g. a contact-form sender.
async function sendMail({ to, subject, text, replyTo }, env = process.env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return 'skipped';
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, ...(replyTo && { reply_to: replyTo }) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`mail ${r.status}`);
  return 'sent';
}
module.exports = { sendMail };
