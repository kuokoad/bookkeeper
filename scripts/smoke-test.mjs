#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING server.
 *
 * Verifies the whole stack together — HTTP, session cookie, auth guard and the
 * ledger-derived dashboard — in a way unit tests cannot. Mints a session by
 * calling the real login service, then makes real HTTP requests with the cookie.
 *
 * Usage: node scripts/smoke-test.mjs [baseUrl]
 */
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'http://localhost:3000';

let failures = 0;
function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${name}${detail && !condition ? ` -> ${detail}` : ''}`);
}

/**
 * Page checks return `[passed, detail]` for `check(name, ...sees(html, 'x'))`,
 * so a failure says what it looked for and what the page showed instead. A bare
 * FAIL went unread in CI for seven weeks: nobody could tell a renamed demo
 * product from a broken page without rebuilding the run locally.
 */
function sees(html, ...needles) {
  const missing = needles.filter((n) => !found(html, n));
  return [missing.length === 0, `looked for ${missing.map(show).join(' and ')}; saw ${glimpse(html)}`];
}

/** The inverse: none of these may appear. Shows where an unwanted one did. */
function lacks(html, ...needles) {
  const present = needles.filter((n) => found(html, n));
  const near = present.map((n) => {
    const at = typeof n === 'string' ? html.indexOf(n) : html.search(n);
    return `${show(n)} in ${glimpse(html.slice(Math.max(0, at - 300), at + 300), false)}`;
  });
  return [present.length === 0, `found ${near.join('; ')}`];
}

function found(html, needle) {
  return typeof needle === 'string' ? html.includes(needle) : needle.test(html);
}

function show(needle) {
  return typeof needle === 'string' ? `"${needle}"` : String(needle);
}

/** The page's visible text, trimmed: the main content when there is one, not the menu. */
function glimpse(html, preferMain = true) {
  if (!html) return 'an empty body (non-200 status or redirect)';
  const main = preferMain ? /<main[\s\S]*?<\/main>/.exec(html)?.[0] : undefined;
  const text = (main ?? html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>|<[^>]*$|^[^<]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return `"${text.slice(0, 400)}${text.length > 400 ? '…' : ''}"`;
}

/** Mint a real session token by calling the app's own login service. */
/**
 * `expectFailure` keeps the deliberate wrong-credential checks from printing an
 * alarming line for the outcome they are asking for. A genuine failure is still
 * reported.
 */
function mintSession(
  username = 'owner',
  password = 'demo-owner-2026',
  { pin = false, expectFailure = false } = {},
) {
  // Invoke node directly with the tsx loader. Spawning `npx.cmd` without a
  // shell fails with EINVAL on Windows, and enabling the shell would mean
  // unescaped argument concatenation.
  try {
    return execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/mint-session.ts',
        username,
        password,
        ...(pin ? ['--pin'] : []),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    if (!expectFailure) {
      console.error('  could not mint a session:', error.stderr?.toString().trim() || error.message);
    }
    return '';
  }
}

console.log(`Smoke testing ${base}\n`);

console.log('Unauthenticated:');
const rootRes = await fetch(`${base}/`, { redirect: 'manual' });
check('GET / redirects', rootRes.status === 307 || rootRes.status === 302, `status ${rootRes.status}`);
check('  -> to /login', (rootRes.headers.get('location') ?? '').includes('/login'));

const dashRes = await fetch(`${base}/dashboard`, { redirect: 'manual' });
check(
  'GET /dashboard is protected',
  (dashRes.status === 307 || dashRes.status === 302) &&
    (dashRes.headers.get('location') ?? '').includes('/login'),
  `status ${dashRes.status}`,
);

const loginRes = await fetch(`${base}/login`);
const loginHtml = await loginRes.text();
check('GET /login renders', loginRes.status === 200 && loginHtml.includes('name="username"'));
check('security headers set', loginRes.headers.get('x-frame-options') === 'DENY');

console.log('\nAuthenticated:');
const token = mintSession();
check('session token minted', Boolean(token) && token.length > 20);

const cookie = `bk_session=${token}`;

/**
 * The shop's name as currently configured, read from the settings form rather
 * than assumed to be the seeded one. The owner can rename the shop, and a test
 * that hard-codes the seed value starts failing the moment they do — reporting
 * a working feature as broken.
 */
const shopName = await (async () => {
  const res = await fetch(`${base}/settings`, { headers: { cookie }, redirect: 'manual' });
  if (res.status !== 200) return null;
  const html = await res.text();
  const match = html.match(/id="businessName"[^>]*value="([^"]*)"/);
  // HTML-escaped in the attribute; unescape what a shop name can contain.
  return match
    ? match[1].replace(/&amp;/g, '&').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"')
    : null;
})();
check('the shop has a name configured', Boolean(shopName), String(shopName));

/**
 * React escapes text when it renders, so a shop called "Nuna Trading & Co."
 * appears in the HTML as "Nuna Trading &amp; Co.". Comparing the raw name
 * against the page would report correct output as a failure.
 */
function appearsIn(html, text) {
  if (!text) return false;
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
  return html.includes(text) || html.includes(escaped);
}

const authed = await fetch(`${base}/dashboard`, {
  headers: { cookie },
  redirect: 'manual',
});
const authedHtml = authed.status === 200 ? await authed.text() : '';
check('GET /dashboard with session', authed.status === 200, `status ${authed.status}`);
check('shows the shop name', appearsIn(authedHtml, shopName), `looking for "${shopName}"`);
check('shows money accounts', ...sees(authedHtml, 'MTN MoMo', 'Cash'));
check('renders GHS amounts', ...sees(authedHtml, 'GHS'));
check('reports the books as balanced', ...sees(authedHtml, /Debits equal credits(?:(?!<\/dd>)[\s\S])*Passed/));
// The Books Check card says how many journal entries produced the figures,
// zero included. A bare unexplained number is not acceptable.
check('explains where the figures come from', ...sees(authedHtml, /\d+(?:<!-- -->)?\s*journal entries checked/));

const rootAuthed = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' });
check(
  'GET / sends a signed-in user to the dashboard',
  (rootAuthed.headers.get('location') ?? '').includes('/dashboard'),
);

const loginAuthed = await fetch(`${base}/login`, { headers: { cookie }, redirect: 'manual' });
check(
  'GET /login sends a signed-in user away',
  (loginAuthed.headers.get('location') ?? '').includes('/dashboard'),
);

const DASH_HEADER = String.fromCharCode(10) + 'Dashboard:';

console.log(DASH_HEADER);
check('dashboard draws charts', (authedHtml.match(/<svg/g) ?? []).length >= 3);
// A shape tells a screen reader nothing, and cannot be read over the phone.
const labelled = (authedHtml.match(/role="img"/g) ?? []).length;
check('every chart has a written summary', labelled >= 3, `${labelled} labelled`);
check('and the figures are still text', ...sees(authedHtml, 'Money accounts'));
check('cards cover the money questions', ...sees(authedHtml, 'Cash movements', 'Expenses', 'Receivables &amp; payables', 'Books Check'));
// This claimed stages 1 and 2 were complete, long after stage 15.
check('the stale build-progress panel is gone', ...lacks(authedHtml, 'Build progress'));

const weekView = await fetch(`${base}/dashboard?sales=week`, { headers: { cookie }, redirect: 'manual' });
const weekHtml = weekView.status === 200 ? await weekView.text() : '';
check('the period selector works', weekView.status === 200, `status ${weekView.status}`);
// The picker reads 7d / 30d / 90d; the chosen one carries aria-current.
check('and marks the chosen period', ...sees(weekHtml, /aria-current="true"[^>]*sales=week[^>]*>7d</));


const SHELL_HEADER = String.fromCharCode(10) + 'Shell, search and notifications:';

console.log(SHELL_HEADER);
check('the sidebar is dark chrome', ...sees(authedHtml, 'bg-sidebar'));

// A switch, not a dropdown: both halves ship, CSS shows one.
check('a theme switch is offered', ...sees(authedHtml, 'theme-when-light'));
check('  with the other half ready', ...sees(authedHtml, 'theme-when-dark'));
// With no preference stored, nothing may be forced onto <html>, or the device
// setting would be overridden by the app's own default.
check('  and no scheme is forced by default', ...lacks(authedHtml, 'data-theme='));

const darkView = await fetch(`${base}/dashboard`, {
  headers: { cookie: `${cookie}; bk_theme=dark` },
});
const darkHtml = await darkView.text();
check('choosing dark is applied server-side', ...sees(darkHtml, 'data-theme="dark"'));
check('  and no reset link is offered', ...lacks(darkHtml, 'Match device'));

const lightHtml = await (
  await fetch(`${base}/dashboard`, { headers: { cookie: `${cookie}; bk_theme=light` } })
).text();
check('choosing light is applied server-side', ...sees(lightHtml, 'data-theme="light"'));

const junkHtml = await (
  await fetch(`${base}/dashboard`, { headers: { cookie: `${cookie}; bk_theme=purple` } })
).text();
// A cookie is user-editable; junk must fall back rather than reach the markup.
check('a junk theme cookie is ignored', ...lacks(junkHtml, 'data-theme='));
check('no New sale button in the sidebar', ...lacks(authedHtml, 'New sale'));
check('the top bar carries search', ...sees(authedHtml, 'action="/search"'));
check('and a notifications panel', ...sees(authedHtml, 'Needs attention'));
// The sidebar is desktop-only, so without this a phone user cannot sign out.
check('sign-out is reachable on a phone', ...sees(authedHtml, 'Sign out'));

// The menu folds, and the section you are in is already open on arrival.
check('menu sections fold', (authedHtml.match(/<details/g) ?? []).length >= 5);
check('and the current one is open', ...sees(authedHtml, 'open=""'));
// Daily and Stock stay open wherever you are; on the dashboard the current
// section IS Daily, so two open sections is the floor, not three.
check('the everyday sections stay open', (authedHtml.match(/open=""/g) ?? []).length >= 2);
check('the sidebar sticks while content scrolls', ...sees(authedHtml, 'lg:sticky'));
check('opening a section is animated', ...sees(authedHtml, 'motion-reveal'));

// Three pages were taken out of the menu. Each MUST still be linked from the
// screen it now belongs to, or it is orphaned — worse than a long menu.
for (const [parent, child] of [
  ['/expenses', '/income'],
  ['/accounting', '/reconciliation'],
  ['/users', '/users/audit'],
]) {
  const page = await fetch(`${base}${parent}`, { headers: { cookie }, redirect: 'manual' });
  const html = page.status === 200 ? await page.text() : '';
  check(`${parent} still links to ${child}`, html.includes(`"${child}"`), `status ${page.status}`);

  const reachable = await fetch(`${base}${child}`, { headers: { cookie }, redirect: 'manual' });
  check(`  and ${child} opens`, reachable.status === 200, `status ${reachable.status}`);
}

const searchRes = await fetch(`${base}/search?q=cement`, { headers: { cookie }, redirect: 'manual' });
const searchHtml = searchRes.status === 200 ? await searchRes.text() : '';
check('GET /search', searchRes.status === 200, `status ${searchRes.status}`);
check('finds a product', ...sees(searchHtml, 'Cement 50kg'));
check('a one-letter search is refused', (await (await fetch(`${base}/search?q=a`, { headers: { cookie } })).text()).includes('at least two characters'));

const staffSearchToken = mintSession('ama', 'demo-staff-2026');
if (staffSearchToken) {
  const staffCookie2 = `bk_session=${staffSearchToken}`;
  // Staff may look up a product, so the box in their top bar must work.
  const staffSearch = await fetch(`${base}/search?q=cement`, { headers: { cookie: staffCookie2 }, redirect: 'manual' });
  check('staff CAN search', staffSearch.status === 200, `status ${staffSearch.status}`);

  // ...but a supplier they may not see must not exist for them.
  const staffBlocked = await fetch(`${base}/search?q=ghacem`, { headers: { cookie: staffCookie2 } });
  const blockedHtml = await staffBlocked.text();
  check('and never sees records outside their access', ...lacks(blockedHtml, 'Ghacem Depot'));
}


console.log('\nProducts & inventory:');
const productsRes = await fetch(`${base}/products`, { headers: { cookie }, redirect: 'manual' });
const productsHtml = productsRes.status === 200 ? await productsRes.text() : '';
check('GET /products', productsRes.status === 200, `status ${productsRes.status}`);
check('lists seeded products', ...sees(productsHtml, 'Cement 50kg'));
check('shows stock quantities', ...sees(productsHtml, /\d+(?:<!-- -->)?\s*bag/));
// Nails are weighed and sold in fractional kg, proving milli-unit quantities
// survive the whole round trip. Matched by shape, not by a literal that
// changes every time the demo data trades.
check('shows a fractional kg quantity', ...sees(productsHtml, /\d+\.\d+(?:<!-- -->)?\s*kg/));
check('flags low stock', productsHtml.includes('Low') || productsHtml.includes('Out'));
check('shows stock value in GHS', ...sees(productsHtml, 'GHS'));

const invRes = await fetch(`${base}/inventory`, { headers: { cookie }, redirect: 'manual' });
const invHtml = invRes.status === 200 ? await invRes.text() : '';
check('GET /inventory', invRes.status === 200, `status ${invRes.status}`);
check('shows the stock ledger', ...sees(invHtml, 'Stock ledger'));
check('shows opening stock movements', ...sees(invHtml, 'Opening stock'));
check('shows adjustment reference', ...sees(invHtml, /ADJ-\d+/));
check(
  'reports NO inventory/ledger drift',
  ...lacks(invHtml, 'disagree with the ledger', 'does not match the accounts'),
);

const catRes = await fetch(`${base}/products/categories`, { headers: { cookie }, redirect: 'manual' });
const catHtml = catRes.status === 200 ? await catRes.text() : '';
check('GET /products/categories', catRes.status === 200, `status ${catRes.status}`);
check('lists seeded categories', ...sees(catHtml, 'Cement', 'Steel'));

const adjRes = await fetch(`${base}/inventory/adjustments`, { headers: { cookie }, redirect: 'manual' });
const adjHtml = adjRes.status === 200 ? await adjRes.text() : '';
check('GET /inventory/adjustments', adjRes.status === 200, `status ${adjRes.status}`);
check('lists the opening stock document', ...sees(adjHtml, 'Opening stock'));

const newAdjRes = await fetch(`${base}/inventory/adjustments/new`, {
  headers: { cookie },
  redirect: 'manual',
});
check('GET /inventory/adjustments/new', newAdjRes.status === 200, `status ${newAdjRes.status}`);

const newProdRes = await fetch(`${base}/products/new`, { headers: { cookie }, redirect: 'manual' });
check('GET /products/new', newProdRes.status === 200, `status ${newProdRes.status}`);

console.log('\nSales & customers:');
const salesRes = await fetch(`${base}/sales`, { headers: { cookie }, redirect: 'manual' });
const salesHtml = salesRes.status === 200 ? await salesRes.text() : '';
check('GET /sales', salesRes.status === 200, `status ${salesRes.status}`);
check('lists receipts', ...sees(salesHtml, /RCP-\d+/));
check('shows profit column', ...sees(salesHtml, 'Profit'));
check('flags credit sales', ...sees(salesHtml, 'Credit'));

const posRes = await fetch(`${base}/sales/new`, { headers: { cookie }, redirect: 'manual' });
const posHtml = posRes.status === 200 ? await posRes.text() : '';
check('GET /sales/new (POS)', posRes.status === 200, `status ${posRes.status}`);
check('POS has product search', ...sees(posHtml, 'Find a product'));
check('POS offers payment methods', ...sees(posHtml, 'MTN MoMo'));

// Follow a real receipt through to its detail page and printable receipt.
const receiptMatch = /\/sales\/(\d+)"/.exec(salesHtml);
const someSaleId = receiptMatch?.[1];
check('found a sale to open', Boolean(someSaleId));
if (someSaleId) {
  const detail = await fetch(`${base}/sales/${someSaleId}`, { headers: { cookie }, redirect: 'manual' });
  const detailHtml = detail.status === 200 ? await detail.text() : '';
  check('GET /sales/[id]', detail.status === 200, `status ${detail.status}`);
  check('shows the accounting entry', ...sees(detailHtml, 'Accounting entry'));
  check('states the entry balances', ...sees(detailHtml, 'Debits equal credits'));
  check('shows cost of goods', ...sees(detailHtml, 'Cost of goods'));

  const receipt = await fetch(`${base}/sales/${someSaleId}/receipt`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const receiptHtml = receipt.status === 200 ? await receipt.text() : '';
  check('GET /sales/[id]/receipt', receipt.status === 200, `status ${receipt.status}`);
  check('receipt shows the shop name', appearsIn(receiptHtml, shopName), `looking for "${shopName}"`);
  // The tagline is a setting, so read the configured value rather than
  // expecting fixed wording — the same reason the shop name is read, not typed.
  const settingsForTagline = await fetch(`${base}/settings`, { headers: { cookie } });
  const taglineMatch = (await settingsForTagline.text()).match(
    /id="tagline"[^>]*value="([^"]*)"/,
  );
  const tagline = taglineMatch ? taglineMatch[1] : '';
  check(
    'receipt shows the tagline when one is set',
    tagline === '' || appearsIn(receiptHtml, tagline),
    `looking for "${tagline}"`,
  );
  check('receipt has a print control', ...sees(receiptHtml, 'Print'));
}

const custRes = await fetch(`${base}/customers`, { headers: { cookie }, redirect: 'manual' });
const custHtml = custRes.status === 200 ? await custRes.text() : '';
check('GET /customers', custRes.status === 200, `status ${custRes.status}`);
check('lists seeded customers', ...sees(custHtml, 'Adom Construction Ltd'));
check('shows total owed', ...sees(custHtml, 'Total owed to you'));

const custIdMatch = /\/customers\/(\d+)"/.exec(custHtml);
if (custIdMatch?.[1]) {
  const profile = await fetch(`${base}/customers/${custIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const profileHtml = profile.status === 200 ? await profile.text() : '';
  check('GET /customers/[id]', profile.status === 200, `status ${profile.status}`);
  check('profile shows what they owe', ...sees(profileHtml, 'Currently owes'));
}

console.log('\nPurchases & suppliers:');
const purRes = await fetch(`${base}/purchases`, { headers: { cookie }, redirect: 'manual' });
const purHtml = purRes.status === 200 ? await purRes.text() : '';
check('GET /purchases', purRes.status === 200, `status ${purRes.status}`);
check('lists purchase references', ...sees(purHtml, /PUR-\d+/));
check('shows what is owed to suppliers', ...sees(purHtml, 'You owe suppliers'));
check('flags credit purchases', ...sees(purHtml, 'Credit'));

const newPurRes = await fetch(`${base}/purchases/new`, { headers: { cookie }, redirect: 'manual' });
const newPurHtml = newPurRes.status === 200 ? await newPurRes.text() : '';
check('GET /purchases/new', newPurRes.status === 200, `status ${newPurRes.status}`);
check('purchase form lists suppliers', ...sees(newPurHtml, 'Ghacem Depot'));

const purIdMatch = /\/purchases\/(\d+)"/.exec(purHtml);
if (purIdMatch?.[1]) {
  const detail = await fetch(`${base}/purchases/${purIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const detailHtml = detail.status === 200 ? await detail.text() : '';
  check('GET /purchases/[id]', detail.status === 200, `status ${detail.status}`);
  check('shows the accounting entry', ...sees(detailHtml, 'Accounting entry'));
  check('states the entry balances', ...sees(detailHtml, 'Debits equal credits'));
  check('offers a supplier return', ...sees(detailHtml, 'Return goods to this supplier'));
}

const supRes = await fetch(`${base}/suppliers`, { headers: { cookie }, redirect: 'manual' });
const supHtml = supRes.status === 200 ? await supRes.text() : '';
check('GET /suppliers', supRes.status === 200, `status ${supRes.status}`);
check('lists seeded suppliers', ...sees(supHtml, 'Ghacem Depot'));
check('shows total payable', ...sees(supHtml, 'Total you owe'));

const supIdMatch = /\/suppliers\/(\d+)"/.exec(supHtml);
if (supIdMatch?.[1]) {
  const profile = await fetch(`${base}/suppliers/${supIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const profileHtml = profile.status === 200 ? await profile.text() : '';
  check('GET /suppliers/[id]', profile.status === 200, `status ${profile.status}`);
  check('profile shows what you owe', ...sees(profileHtml, 'You currently owe'));
}

// A customer return must be offered on a real sale.
if (someSaleId) {
  const saleDetail = await fetch(`${base}/sales/${someSaleId}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const saleHtml = saleDetail.status === 200 ? await saleDetail.text() : '';
  check('sale offers a customer return', ...sees(saleHtml, 'Customer return'));
}

console.log('\nExpenses, income & accounts:');
const expRes = await fetch(`${base}/expenses?period=all`, { headers: { cookie }, redirect: 'manual' });
const expHtml = expRes.status === 200 ? await expRes.text() : '';
check('GET /expenses', expRes.status === 200, `status ${expRes.status}`);
check('lists seeded expenses', ...sees(expHtml, 'Yard rent for the month'));
check('groups spending by category', ...sees(expHtml, 'Where the money went'));
check('offers the expense form', ...sees(expHtml, 'Record an expense'));

const incRes = await fetch(`${base}/income?period=all`, { headers: { cookie }, redirect: 'manual' });
const incHtml = incRes.status === 200 ? await incRes.text() : '';
check('GET /income', incRes.status === 200, `status ${incRes.status}`);
check('lists other income', ...sees(incHtml, 'Weighbridge fee recovered'));

const accRes = await fetch(`${base}/accounts`, { headers: { cookie }, redirect: 'manual' });
const accHtml = accRes.status === 200 ? await accRes.text() : '';
check('GET /accounts', accRes.status === 200, `status ${accRes.status}`);
check('lists money accounts', ...sees(accHtml, 'MTN MoMo', 'Bank Account'));
check('shows total money held', ...sees(accHtml, 'Total money held'));
check('books report as balanced', ...lacks(accHtml, 'The books do not balance'));
check('no account is negative', ...lacks(accHtml, 'negative balance'));

const accIdMatch = /\/accounts\/(\d+)"/.exec(accHtml);
if (accIdMatch?.[1]) {
  const movements = await fetch(`${base}/accounts/${accIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const movHtml = movements.status === 200 ? await movements.text() : '';
  check('GET /accounts/[id]', movements.status === 200, `status ${movements.status}`);
  check('shows a running balance', ...sees(movHtml, 'Balance'));
  check('explains where the balance came from', ...sees(movHtml, 'why is the balance'));
  check('labels movement sources', ...sees(movHtml, /Expense|Sale|Purchase|Other income/));
}

// Minted early so the books-lock section can check staff access too.
let staffTokenForLock = '';
try {
  staffTokenForLock = mintSession('ama', 'demo-staff-2026');
} catch {
  staffTokenForLock = '';
}

console.log('\nAccounting:');
const acctRes = await fetch(`${base}/accounting`, { headers: { cookie }, redirect: 'manual' });
const acctHtml = acctRes.status === 200 ? await acctRes.text() : '';
check('GET /accounting', acctRes.status === 200, `status ${acctRes.status}`);
check('reports the books as healthy', ...sees(acctHtml, 'The books are healthy'));
check('NO integrity problems reported', ...lacks(acctHtml, 'Something is wrong with the books'));

const chartRes = await fetch(`${base}/accounting/chart`, { headers: { cookie }, redirect: 'manual' });
const chartHtml = chartRes.status === 200 ? await chartRes.text() : '';
check('GET /accounting/chart', chartRes.status === 200, `status ${chartRes.status}`);
check('lists real accounts', ...sees(chartHtml, 'Accounts Receivable', 'Inventory'));

const tbRes = await fetch(`${base}/accounting/trial-balance`, { headers: { cookie }, redirect: 'manual' });
const tbHtml = tbRes.status === 200 ? await tbRes.text() : '';
check('GET /accounting/trial-balance', tbRes.status === 200, `status ${tbRes.status}`);
check('trial balance balances', ...sees(tbHtml, 'The books balance'));

const jRes = await fetch(`${base}/accounting/journal`, { headers: { cookie }, redirect: 'manual' });
const jHtml = jRes.status === 200 ? await jRes.text() : '';
check('GET /accounting/journal', jRes.status === 200, `status ${jRes.status}`);
check('lists journal entries', ...sees(jHtml, /JE-\d+/));
check('NO unbalanced entries flagged', ...lacks(jHtml, 'do not balance'));

const jIdMatch = /\/accounting\/journal\/(\d+)"/.exec(jHtml);
if (jIdMatch?.[1]) {
  const entry = await fetch(`${base}/accounting/journal/${jIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const entryHtml = entry.status === 200 ? await entry.text() : '';
  check('GET /accounting/journal/[id]', entry.status === 200, `status ${entry.status}`);
  check('entry shows debits equal credits', ...sees(entryHtml, 'Debits equal credits'));
}

const ledgerMatch = /\/accounting\/ledger\/(\d+)"/.exec(chartHtml);
if (ledgerMatch?.[1]) {
  const led = await fetch(`${base}/accounting/ledger/${ledgerMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const ledHtml = led.status === 200 ? await led.text() : '';
  check('GET /accounting/ledger/[id]', led.status === 200, `status ${led.status}`);
  check('ledger shows a running balance', ...sees(ledHtml, 'Balance'));
}

const recRes = await fetch(`${base}/accounting/receivables`, { headers: { cookie }, redirect: 'manual' });
const recHtml = recRes.status === 200 ? await recRes.text() : '';
check('GET /accounting/receivables', recRes.status === 200, `status ${recRes.status}`);
check('ageing agrees with the ledger', ...lacks(recHtml, 'does not agree with the ledger'));
check('ageing shows buckets', ...sees(recHtml, 'Over 90'));

const payRes = await fetch(`${base}/accounting/payables`, { headers: { cookie }, redirect: 'manual' });
const payHtml = payRes.status === 200 ? await payRes.text() : '';
check('GET /accounting/payables', payRes.status === 200, `status ${payRes.status}`);
check('payables agree with the ledger', ...lacks(payHtml, 'does not agree with the ledger'));
check('lists a supplier owed', ...sees(payHtml, 'Ghacem Depot'));

console.log('\nReports:');
const repRes = await fetch(`${base}/reports`, { headers: { cookie }, redirect: 'manual' });
const repHtml = repRes.status === 200 ? await repRes.text() : '';
check('GET /reports', repRes.status === 200, `status ${repRes.status}`);
check('NO balance sheet warning', ...lacks(repHtml, 'does not balance'));

const plRes = await fetch(`${base}/reports/profit-and-loss?period=all`, {
  headers: { cookie },
  redirect: 'manual',
});
const plHtml = plRes.status === 200 ? await plRes.text() : '';
check('GET /reports/profit-and-loss', plRes.status === 200, `status ${plRes.status}`);
check('P&L shows gross and net profit', ...sees(plHtml, 'Gross profit', 'Net profit'));
check('P&L shows cost of goods sold', ...sees(plHtml, 'Cost of goods sold'));

const bsRes = await fetch(`${base}/reports/balance-sheet`, { headers: { cookie }, redirect: 'manual' });
const bsHtml = bsRes.status === 200 ? await bsRes.text() : '';
check('GET /reports/balance-sheet', bsRes.status === 200, `status ${bsRes.status}`);
check('BALANCE SHEET BALANCES', ...sees(bsHtml, 'exactly equals what it owes'));
check('no balance warning shown', ...lacks(bsHtml, 'does not balance'));

const cfRes = await fetch(`${base}/reports/cash-flow?period=all`, { headers: { cookie }, redirect: 'manual' });
const cfHtml = cfRes.status === 200 ? await cfRes.text() : '';
check('GET /reports/cash-flow', cfRes.status === 200, `status ${cfRes.status}`);
check('cash flow reconciles', ...lacks(cfHtml, 'does not reconcile'));

for (const [path, label] of [
  ['/reports/sales?period=all', 'sales'],
  ['/reports/purchases?period=all', 'purchases'],
  ['/reports/inventory', 'inventory'],
]) {
  const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  check(`GET /reports/${label}`, res.status === 200, `status ${res.status}`);
}

const invReportRes = await fetch(`${base}/reports/inventory`, {
  headers: { cookie },
  redirect: 'manual',
});
const invReportHtml = invReportRes.status === 200 ? await invReportRes.text() : '';
check('inventory report matches the accounts', ...lacks(invReportHtml, 'does not match the accounts'));

console.log('\nCSV export:');
for (const report of [
  'profit-and-loss',
  'balance-sheet',
  'cash-flow',
  'sales',
  'purchases',
  'inventory',
  'receivables',
  'payables',
]) {
  const res = await fetch(`${base}/api/reports/${report}?from=0000-01-01&to=2099-12-31`, {
    headers: { cookie },
  });
  const body = res.status === 200 ? await res.text() : '';
  const ok =
    res.status === 200 &&
    (res.headers.get('content-type') ?? '').includes('text/csv') &&
    (res.headers.get('content-disposition') ?? '').includes('.csv') &&
    body.includes(',');
  check(`CSV ${report}`, ok, `status ${res.status}`);
}

const badCsv = await fetch(`${base}/api/reports/does-not-exist`, { headers: { cookie } });
check('unknown CSV report 404s', badCsv.status === 404, `status ${badCsv.status}`);

const anonCsv = await fetch(`${base}/api/reports/profit-and-loss`, { redirect: 'manual' });
check('CSV export requires sign-in', anonCsv.status === 401, `status ${anonCsv.status}`);

console.log('\nReconciliation:');
const recoRes = await fetch(`${base}/reconciliation`, { headers: { cookie }, redirect: 'manual' });
const recoHtml = recoRes.status === 200 ? await recoRes.text() : '';
check('GET /reconciliation', recoRes.status === 200, `status ${recoRes.status}`);
check('lists past counts', ...sees(recoHtml, /REC-\d+/));
check('shows what the books say vs counted', ...sees(recoHtml, 'Books say'));
check('shows the seeded shortage', ...sees(recoHtml, '-3.50'));
check('explains the difference', ...sees(recoHtml, 'wrong change'));
check('marks the clean count as agreed', ...sees(recoHtml, 'Agreed'));
check('offers a count form', ...sees(recoHtml, 'Count an account'));
check('links to closing the books', ...sees(recoHtml, 'stops anything being added behind it'));

// The shortage must be visible as a cost on the P&L, not absorbed silently.
const plReco = await fetch(`${base}/reports/profit-and-loss?period=all`, {
  headers: { cookie },
  redirect: 'manual',
});
const plRecoHtml = plReco.status === 200 ? await plReco.text() : '';
check('shortage shows on the P&L', ...sees(plRecoHtml, 'Cash Over / Short'));

if (staffTokenForLock) {
  const staffReco = await fetch(`${base}/reconciliation`, {
    headers: { cookie: `bk_session=${staffTokenForLock}` },
    redirect: 'manual',
  });
  check(
    'staff cannot reconcile',
    staffReco.status !== 200,
    `status ${staffReco.status}`,
  );
}

console.log('\nBooks lock:');
const lockRes = await fetch(`${base}/accounting`, { headers: { cookie }, redirect: 'manual' });
const lockHtml = lockRes.status === 200 ? await lockRes.text() : '';
check('owner sees the books lock control', ...sees(lockHtml, 'Books lock'));
check('explains what is unlocked', lockHtml.includes('Nothing is locked') || lockHtml.includes('closed up to'));

if (staffTokenForLock) {
  const staffAcct = await fetch(`${base}/accounting`, {
    headers: { cookie: `bk_session=${staffTokenForLock}` },
    redirect: 'manual',
  });
  // Staff have no `accounts` permission at all, so the page is refused outright.
  check(
    'staff cannot reach the accounting section',
    staffAcct.status !== 200,
    `status ${staffAcct.status}`,
  );
}

console.log('\nUsers:');
const usersRes = await fetch(`${base}/users`, { headers: { cookie }, redirect: 'manual' });
const usersHtml = usersRes.status === 200 ? await usersRes.text() : '';
check('GET /users', usersRes.status === 200, `status ${usersRes.status}`);
check('lists both demo accounts', ...sees(usersHtml, 'Demo Owner', 'Ama'));
check('marks the signed-in person', ...sees(usersHtml, '>You<'));
check('shows who holds a till PIN', ...sees(usersHtml, 'has a till PIN'));
check('shows roles', ...sees(usersHtml, 'Owner', 'Staff'));
check('offers NO delete control', !/Delete\s*(user|person|account)/i.test(usersHtml));

const staffRow = usersHtml.match(/\/users\/(\d+)"/);
if (staffRow) {
  const detail = await fetch(`${base}/users/${staffRow[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const detailHtml = detail.status === 200 ? await detail.text() : '';
  check('GET /users/[id]', detail.status === 200, `status ${detail.status}`);
  check('shows recent activity', ...sees(detailHtml, 'Recent activity'));
  check('detail page offers NO delete', !/Delete\s*(user|person|account)/i.test(detailHtml));
}

const newUserRes = await fetch(`${base}/users/new`, { headers: { cookie }, redirect: 'manual' });
const newUserHtml = newUserRes.status === 200 ? await newUserRes.text() : '';
check('GET /users/new', newUserRes.status === 200, `status ${newUserRes.status}`);
check('form has a permission matrix', ...sees(newUserHtml, 'perm:sales:view'));

console.log('\nAudit log:');
const auditRes = await fetch(`${base}/users/audit`, { headers: { cookie }, redirect: 'manual' });
const auditHtml = auditRes.status === 200 ? await auditRes.text() : '';
check('GET /users/audit', auditRes.status === 200, `status ${auditRes.status}`);
check('records exist', ...sees(auditHtml, 'Records found'));
check('shows sign-in events', ...sees(auditHtml, 'Signed in'));
// The seeding, selling and counting done in earlier stages must all be on record.
check('records who did what', auditHtml.includes('owner') || auditHtml.includes('Demo Owner'));
check(
  'leaks NO password or PIN',
  !auditHtml.includes('demo-owner-2026') &&
    !auditHtml.includes('demo-staff-2026') &&
    !auditHtml.includes('8351'),
);
check('states the log cannot be edited', ...sees(auditHtml, 'can be edited or removed'));

/** "Records found" from the stat block — the count the filter actually returned. */
function recordsFound(html) {
  const match = html.match(/Records found<\/p>[\s\S]*?class="tabular[^"]*">([\d,]+)</);
  return match ? Number(match[1].replace(/,/g, '')) : NaN;
}

const auditFiltered = await fetch(`${base}/users/audit?action=LOGIN_SUCCESS`, {
  headers: { cookie },
  redirect: 'manual',
});
const auditFilteredHtml = auditFiltered.status === 200 ? await auditFiltered.text() : '';
check('filters by action', auditFiltered.status === 200 && auditFilteredHtml.includes('Signed in'));
// Compare counts rather than looking for absent words: every action name appears
// in the filter dropdown regardless of what the rows contain.
const allCount = recordsFound(auditHtml);
const loginCount = recordsFound(auditFilteredHtml);
check(
  'filtering narrows the results',
  Number.isFinite(allCount) && Number.isFinite(loginCount) && loginCount > 0 && loginCount < allCount,
  `all ${allCount}, filtered ${loginCount}`,
);

const auditNoMatch = await fetch(`${base}/users/audit?from=2000-01-01&to=2000-01-02`, {
  headers: { cookie },
  redirect: 'manual',
});
const auditNoMatchHtml = auditNoMatch.status === 200 ? await auditNoMatch.text() : '';
check('an empty result says so plainly', ...sees(auditNoMatchHtml, 'Nothing matches'));

console.log('\nTill PIN sign-in:');
const pinToken = mintSession('ama', '8351', { pin: true });
check('PIN mints a working session', Boolean(pinToken) && pinToken.length > 20);
if (pinToken) {
  const pinDash = await fetch(`${base}/sales`, {
    headers: { cookie: `bk_session=${pinToken}` },
    redirect: 'manual',
  });
  check('PIN session reaches the till', pinDash.status === 200, `status ${pinDash.status}`);
}
const badPin = mintSession('ama', '0000', { pin: true, expectFailure: true });
check('wrong PIN mints nothing', badPin === '');

console.log('\nStaff permissions:');
let staffToken = '';
try {
  staffToken = mintSession('ama', 'demo-staff-2026');
} catch {
  staffToken = '';
}
check('staff session minted', Boolean(staffToken));
if (staffToken) {
  const staffCookie = `bk_session=${staffToken}`;
  const staffProducts = await fetch(`${base}/products`, {
    headers: { cookie: staffCookie },
    redirect: 'manual',
  });
  check('staff CAN view products', staffProducts.status === 200, `status ${staffProducts.status}`);

  // Staff have no `settings` or `users` permission — the server must refuse
  // regardless of what the navigation shows.
  const staffProductsHtml = staffProducts.status === 200 ? await staffProducts.text() : '';
  check('staff nav hides Settings', ...lacks(staffProductsHtml, '>Settings<'));
  check('staff nav hides Users', ...lacks(staffProductsHtml, '>Users<'));

  // Hiding the link is cosmetic. These prove the SERVER refuses, which is the
  // check that actually matters — a staff member typing the address gets out.
  for (const path of ['/users', '/users/new', '/users/audit']) {
    const forbidden = await fetch(`${base}${path}`, {
      headers: { cookie: staffCookie },
      redirect: 'manual',
    });
    const wentAway =
      forbidden.status === 403 ||
      forbidden.status === 404 ||
      (forbidden.headers.get('location') ?? '') !== '';
    check(`staff CANNOT reach ${path}`, wentAway, `status ${forbidden.status}`);
    if (forbidden.status === 200) {
      const leaked = await forbidden.text();
      check(`  and ${path} leaked no user list`, !leaked.includes('Demo Owner'));
    } else {
      check(
        `  and ${path} explains rather than erroring`,
        (forbidden.headers.get('location') ?? '').includes('/no-access'),
        forbidden.headers.get('location') ?? `status ${forbidden.status}`,
      );
    }
  }

  const noAccess = await fetch(`${base}/no-access?area=users`, {
    headers: { cookie: staffCookie },
    redirect: 'manual',
  });
  const noAccessHtml = noAccess.status === 200 ? await noAccess.text() : '';
  check('the no-access page renders', noAccess.status === 200, `status ${noAccess.status}`);
  check('it names the area', ...sees(noAccessHtml, 'users'));
  check('it says nothing was changed', ...sees(noAccessHtml, 'nothing was changed'));
  check('it does NOT show a server error', ...lacks(noAccessHtml, 'Application error'));

  // A made-up area must not put arbitrary text on the page.
  const bogus = await fetch(`${base}/no-access?area=%3Cscript%3Ealert(1)%3C%2Fscript%3E`, {
    headers: { cookie: staffCookie },
    redirect: 'manual',
  });
  const bogusHtml = bogus.status === 200 ? await bogus.text() : '';
  check('an unknown area is not echoed back', ...lacks(bogusHtml, '<script>alert(1)</script>'));
}

console.log('\nYear-end close:');
const closeRes = await fetch(`${base}/accounting`, { headers: { cookie }, redirect: 'manual' });
const acctPageHtml = closeRes.status === 200 ? await closeRes.text() : '';
check('accounting page offers the year-end close', ...sees(acctPageHtml, 'Year-end close'));
check('explains what closing does', ...sees(acctPageHtml, 'Retained Earnings'));
check('states nothing recorded is altered', ...sees(acctPageHtml, 'Nothing already recorded is altered'));
// Closing must be reversible, and say so where the button is.
check('offers reopening or explains none is closable', ...sees(acctPageHtml, /Reopen|no finished year/i));

const INVOICE_HEADER = String.fromCharCode(10) + 'Invoicing:';

console.log(INVOICE_HEADER);
const ageingExport = await fetch(`${base}/api/reports/receivables?to=2099-01-01`, {
  headers: { cookie },
});
check('ageing export still works', ageingExport.status === 200, `status ${ageingExport.status}`);

// Find a sale that carries an invoice number.
const salesList = await (await fetch(`${base}/sales`, { headers: { cookie } })).text();
const saleIds = [...salesList.matchAll(/href="\/sales\/(\d+)"/g)].map((m) => m[1]);
let invoiceFound = false;
for (const id of saleIds.slice(0, 12)) {
  const page = await fetch(`${base}/sales/${id}/invoice`, { headers: { cookie }, redirect: 'manual' });
  if (page.status !== 200) continue;
  const html = await page.text();
  if (!/INV-\d+/.test(html)) continue;

  invoiceFound = true;
  check('an invoice renders', true);
  check('  it is framed as a request for payment', ...sees(html, 'Amount due'));
  check('  it names who owes', ...sees(html, 'Billed to'));
  check('  it states the terms', ...sees(html, /Payment terms|due on receipt/i));
  check('  and says how to reference the payment', ...sees(html, 'Quote'));
  break;
}
if (!invoiceFound) {
  // A shop with no credit sales is a valid state, not a failure.
  check('no credit sale to invoice yet (valid)', true);
}

// A cash sale must NOT be given an invoice document.
for (const id of saleIds.slice(0, 12)) {
  const html = await (await fetch(`${base}/sales/${id}/invoice`, { headers: { cookie } })).text();
  if (html.includes('This sale has no invoice')) {
    check('a cash sale is refused an invoice, and says why', true);
    break;
  }
}

const stmt = await fetch(`${base}/customers/1/statement`, { headers: { cookie }, redirect: 'manual' });
const stmtHtml = stmt.status === 200 ? await stmt.text() : '';
check('a customer statement renders', stmt.status === 200, `status ${stmt.status}`);
check('  and ties to the ledger', ...lacks(stmtHtml, 'does not tie to the ledger'));


console.log('\nYear-end pack:');
const yeRes = await fetch(`${base}/reports/year-end`, { headers: { cookie }, redirect: 'manual' });
const yeHtml = yeRes.status === 200 ? await yeRes.text() : '';
check('GET /reports/year-end', yeRes.status === 200, `status ${yeRes.status}`);
check('names the shop', appearsIn(yeHtml, shopName));
check('states the period covered', ...sees(yeHtml, 'Financial statements for the year'));
check('has a profit and loss', ...sees(yeHtml, 'Profit and Loss'));
check('has a balance sheet', ...sees(yeHtml, 'Balance Sheet'));
check('has a trial balance', ...sees(yeHtml, 'Trial Balance'));
check("shows the movement in the owner's stake", yeHtml.includes("Movement in the Owner"));
check('has a cash flow', ...sees(yeHtml, 'Cash Flow'));
check('lists what customers owe', ...sees(yeHtml, 'Owed by Customers'));
check('lists what is owed to suppliers', ...sees(yeHtml, 'Owed to Suppliers'));
check('explains the basis of preparation', ...sees(yeHtml, 'Basis of preparation'));
check('states the checks performed', ...sees(yeHtml, 'Checks performed'));
// React separates adjacent text nodes with `<!-- -->` markers when it renders
// on the server, so "Trial balance {verdict}" arrives split. Strip the markers
// before matching, or correct output reads as a failure.
const yeText = yeHtml.replace(/<!--.*?-->/g, '');
// The pack must assert its own integrity, not merely present tidy numbers.
check('reports the trial balance as balancing', ...sees(yeText, 'Trial balance balances'));
check('does NOT report a broken book', ...lacks(yeText, 'DOES NOT BALANCE'));
check("owner's stake reconciles", yeText.includes('stake reconciles'));
check('is honest that the year is still open', yeHtml.includes('not closed') || yeHtml.includes('PROVISIONAL') || yeHtml.includes('has not finished'));

const yeCsv = await fetch(`${base}/api/reports/year-end`, { headers: { cookie }, redirect: 'manual' });
const yeCsvBody = yeCsv.status === 200 ? await yeCsv.text() : '';
check('year-end CSV downloads', yeCsv.status === 200, `status ${yeCsv.status}`);
check(
  'CSV carries the statements',
  ['PROFIT AND LOSS', 'BALANCE SHEET', 'CASH FLOW', 'OWED BY CUSTOMERS', 'TRIAL BALANCE'].every(
    (section) => yeCsvBody.includes(section),
  ),
);
check('CSV carries the checks', ...sees(yeCsvBody, 'CHECKS PERFORMED'));
// And that they actually passed — a pack that says "NO" is the thing to catch.
check('CSV reports the books as sound', !/,NO,/.test(yeCsvBody), 'a check reported NO');

console.log('\nSettings:');
const setRes = await fetch(`${base}/settings`, { headers: { cookie }, redirect: 'manual' });
const setHtml = setRes.status === 200 ? await setRes.text() : '';
check('GET /settings', setRes.status === 200, `status ${setRes.status}`);
check('shows the shop name', appearsIn(setHtml, shopName), `looking for "${shopName}"`);
// The line under the shop name in the menu is a setting now, not a constant.
check('offers the sidebar tagline', ...sees(setHtml, 'name="tagline"'));
check('offers currency', ...sees(setHtml, 'Currency code'));
check('offers tax', ...sees(setHtml, 'Charge tax on sales'));
check('offers stock policy', ...sees(setHtml, 'Allow selling stock you do not have'));
// The demo database has transactions, so the currency must be pinned.
check('currency is locked once there are transactions', ...sees(setHtml, 'currency is fixed'));
check('says changes are recorded', ...sees(setHtml, 'recorded in the audit log'));
/*
  Tax is off in the demo shop, and the form still has to CARRY its tax fields:
  a control nobody can see submits nothing, and saving then fails on a field
  the owner cannot find to fix.

  This used to assert `name="taxLabel"`. The tax-components work replaced the
  shop's single tax name with a table of components, each carrying its own
  name, rate and basis, so that field is gone BY DESIGN — and this check went
  on failing against a settings page that was correct, which is worse than no
  check at all. What remains on this form is the inclusive flag, kept in the
  DOM behind `hidden` for exactly the reason above.
*/
check('the settings form still offers Tax when tax is off', ...sees(setHtml, /<h2[^>]*>Tax<\/h2>/));
check('tax fields still submit when tax is off', ...sees(setHtml, 'name="taxInclusive"'));
check('links to its own change history', ...sees(setHtml, 'entity=business_settings'));

// The nav promised this page with a "Soon" tag until it existed.
const dashForNav = await fetch(`${base}/dashboard`, { headers: { cookie } });
const dashNavHtml = await dashForNav.text();
check('Settings is no longer marked "Soon"', !/Settings[\s\S]{0,120}?Soon/.test(dashNavHtml));

console.log('\nHealth & backup (the no-terminal path):');
const healthRes = await fetch(`${base}/settings/health`, { headers: { cookie }, redirect: 'manual' });
const healthHtml = healthRes.status === 200 ? await healthRes.text() : '';
check('GET /settings/health', healthRes.status === 200, `status ${healthRes.status}`);
check('runs the readiness checks', ...sees(healthHtml, 'The books balance'));
check('offers a backup download', ...sees(healthHtml, '/api/backup'));

const backupRes = await fetch(`${base}/api/backup`, { headers: { cookie }, redirect: 'manual' });
check('backup downloads', backupRes.status === 200, `status ${backupRes.status}`);
check(
  'as a file, not a web page',
  (backupRes.headers.get('content-disposition') ?? '').includes('attachment'),
);
const backupBody = backupRes.status === 200 ? Buffer.from(await backupRes.arrayBuffer()) : Buffer.alloc(0);
// Every SQLite file starts with this. Proves a real database came back rather
// than an error page with a 200 on it.
check('and it is a real SQLite database', backupBody.subarray(0, 15).toString() === 'SQLite format 3');
check('of a plausible size', backupBody.byteLength > 10_000, `${backupBody.byteLength} bytes`);

if (staffTokenForLock) {
  const staffBackup = await fetch(`${base}/api/backup`, {
    headers: { cookie: `bk_session=${staffTokenForLock}` },
    redirect: 'manual',
  });
  // A backup is a complete copy of every customer and every figure.
  check('staff CANNOT download a backup', staffBackup.status === 403, `status ${staffBackup.status}`);
}
const anonBackup = await fetch(`${base}/api/backup`, { redirect: 'manual' });
check('a backup requires signing in', anonBackup.status === 401, `status ${anonBackup.status}`);

const LOGO_HEADER = String.fromCharCode(10) + 'Shop logo:';
const RASTER_TYPES = new RegExp('^image/(png|jpeg|webp)$');

console.log(LOGO_HEADER);
const logoPage = await fetch(`${base}/settings`, { headers: { cookie }, redirect: 'manual' });
const logoPageHtml = logoPage.status === 200 ? await logoPage.text() : '';
check('settings offers a logo upload', ...sees(logoPageHtml, 'name="logo"'));
check(
  'accepts only raster formats in the picker',
  ...sees(logoPageHtml, 'image/png,image/jpeg,image/webp'),
);
check('says SVG is not accepted, and why', ...sees(logoPageHtml, 'SVG files are not accepted'));
check('says it is kept in the database', ...sees(logoPageHtml, 'included in every backup'));

const logoRes = await fetch(`${base}/api/logo`, { redirect: 'manual' });
// Either a real image or a plain 404 - never a page, never a guessable type.
check(
  'logo route answers definitively',
  logoRes.status === 200 || logoRes.status === 404,
  `status ${logoRes.status}`,
);
check(
  'and forbids content-type sniffing',
  logoRes.headers.get('x-content-type-options') === 'nosniff',
);
if (logoRes.status === 200) {
  const type = logoRes.headers.get('content-type') ?? '';
  check('serves a raster image type', RASTER_TYPES.test(type), type);
  check('never serves SVG', ...lacks(type, 'svg'));
}


const MOTION_HEADER = String.fromCharCode(10) + 'Motion:';

console.log(MOTION_HEADER);
const cssHref = (authedHtml.match(/href="([^"]*\.css[^"]*)"/) ?? [])[1];
check('a stylesheet is served', Boolean(cssHref), String(cssHref));
if (cssHref) {
  const cssRes = await fetch(new URL(cssHref, base));
  const css = cssRes.status === 200 ? await cssRes.text() : '';
  check('reduced motion is honoured', ...sees(css, 'prefers-reduced-motion'));
  check('entrance animation ships', ...sees(css, 'motion-page'));
  // A till has a queue behind it; motion must not be something to wait through.
  // The compiler reorders the shorthand and may emit seconds, so read the
  // duration wherever it lands and in whichever unit.
  const durations = [];
  for (const decl of css.matchAll(/animation:\s*([^;}]*)/g)) {
    const found = (decl[1] ?? '').match(/(\d*\.?\d+)(ms|s)/);
    if (found) durations.push(found[2] === 's' ? Number(found[1]) * 1000 : Number(found[1]));
  }
  const longest = Math.max(0, ...durations);
  check('and stays under 200ms', durations.length > 0 && longest <= 200, `${longest}ms`);
}
check('the page content carries the entrance class', ...sees(authedHtml, 'motion-page'));

if (someSaleId) {
  const printable = await fetch(`${base}/sales/${someSaleId}/receipt`, { headers: { cookie } });
  const printableHtml = printable.status === 200 ? await printable.text() : '';
  // A receipt is printed. It must never come out of the printer mid-entrance.
  check('receipt still renders', printable.status === 200, `status ${printable.status}`);
  check('receipt is not wrapped in an entrance', ...lacks(printableHtml, 'class="motion-appear"'));
}


console.log('\nWhen things are missing or wrong:');
const unknownPath = await fetch(`${base}/this-page-does-not-exist`, {
  headers: { cookie },
  redirect: 'manual',
});
const unknownHtml = unknownPath.status === 404 ? await unknownPath.text() : '';
check('unknown address returns 404', unknownPath.status === 404, `status ${unknownPath.status}`);
check('and explains rather than crashing', ...sees(unknownHtml, 'does not exist'));

// A path that matches no route at all falls to the root 404, outside the shell.
// One inside the shell should keep the navigation and say more.
const missingInShell = await fetch(`${base}/sales/99999999`, { headers: { cookie }, redirect: 'manual' });
const missingInShellHtml = missingInShell.status === 404 ? await missingInShell.text() : '';
check(
  'a missing record reassures that nothing was deleted',
  ...sees(missingInShellHtml, 'does not delete financial records'),
);

const missingRecord = await fetch(`${base}/sales/99999999`, { headers: { cookie }, redirect: 'manual' });
check(
  'a record that does not exist returns 404, not a server error',
  missingRecord.status === 404,
  `status ${missingRecord.status}`,
);

const badRecordId = await fetch(`${base}/sales/not-a-number`, {
  headers: { cookie },
  redirect: 'manual',
});
check(
  'a nonsense record id is refused cleanly',
  badRecordId.status === 404,
  `status ${badRecordId.status}`,
);

console.log('\nSigning in:');
const loginPage = await fetch(`${base}/login`);
const loginPageHtml = await loginPage.text();
check('offers a password sign-in', ...sees(loginPageHtml, 'Password'));
check('offers a till PIN sign-in', ...sees(loginPageHtml, 'Till PIN'));

console.log('\nOther:');
const setupClosed = await fetch(`${base}/setup`, { redirect: 'manual' });
check(
  'GET /setup is closed once an owner exists',
  (setupClosed.headers.get('location') ?? '').includes('/login'),
  `status ${setupClosed.status}`,
);

const badCookie = await fetch(`${base}/dashboard`, {
  headers: { cookie: 'bk_session=forged-token-value-that-is-not-real' },
  redirect: 'manual',
});
check(
  'forged session token is rejected',
  (badCookie.headers.get('location') ?? '').includes('/login'),
  `status ${badCookie.status}`,
);

console.log(`\n${failures === 0 ? 'All smoke checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
