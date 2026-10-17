#!/usr/bin/env node
// Create or update a customer portal account in the production store.
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/add-user.js customer@example.com bookscan[,other]
// The password is read from stdin (not argv) so it stays out of shell history.
const readline = require('readline');
const CATALOG = require('../api/_lib/catalog');
const store = require('../api/_lib/store');
const auth = require('../api/_lib/auth');

async function main() {
  const [emailArg, productsArg = ''] = process.argv.slice(2);
  const email = auth.normEmail(emailArg);
  if (!email || !email.includes('@')) throw new Error('usage: node scripts/add-user.js <email> <product1,product2>');
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) throw new Error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  const products = productsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = products.filter((id) => !Object.prototype.hasOwnProperty.call(CATALOG, id));
  if (unknown.length) throw new Error(`unknown product(s): ${unknown.join(', ')}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const password = await new Promise((resolve) => rl.question('Password (min 12 chars): ', (a) => { rl.close(); resolve(a); }));
  if (password.length < 12) throw new Error('Password must be at least 12 characters');

  await store.setJSON(`user:${email}`, { hash: await auth.hashPassword(password), products });
  console.error(`Saved ${email} with access to: ${products.join(', ') || '(nothing yet)'}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
