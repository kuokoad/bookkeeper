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
check('shows money accounts', authedHtml.includes('MTN MoMo') && authedHtml.includes('Cash'));
check('renders GHS amounts', authedHtml.includes('GHS'));
check('reports the books as balanced', authedHtml.includes('Balanced'));
// Before any trading, the dashboard says its zeros are real; afterwards it
// says how many entries produced the figures. Either is correct — a bare
// unexplained number is not.
check(
  'explains where the figures come from',
  authedHtml.includes('genuinely zero') || /Derived from \d+ journal/.test(authedHtml),
);

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

console.log('\nProducts & inventory:');
const productsRes = await fetch(`${base}/products`, { headers: { cookie }, redirect: 'manual' });
const productsHtml = productsRes.status === 200 ? await productsRes.text() : '';
check('GET /products', productsRes.status === 200, `status ${productsRes.status}`);
check('lists seeded products', productsHtml.includes('Milo Tin 400g'));
check('shows stock quantities', productsHtml.includes('bottle') || productsHtml.includes('tin'));
// Rice is stocked and sold in fractional kg, proving milli-unit quantities
// survive the whole round trip. Matched by shape, not by a literal that
// changes every time the demo data trades.
check('shows a fractional kg quantity', /\d+\.\d+\s*kg/.test(productsHtml));
check('flags low stock', productsHtml.includes('Low') || productsHtml.includes('Out'));
check('shows stock value in GHS', productsHtml.includes('GHS'));

const invRes = await fetch(`${base}/inventory`, { headers: { cookie }, redirect: 'manual' });
const invHtml = invRes.status === 200 ? await invRes.text() : '';
check('GET /inventory', invRes.status === 200, `status ${invRes.status}`);
check('shows the stock ledger', invHtml.includes('Stock ledger'));
check('shows opening stock movements', invHtml.includes('Opening stock'));
check('shows adjustment reference', /ADJ-\d+/.test(invHtml));
check(
  'reports NO inventory/ledger drift',
  !invHtml.includes('disagree with the ledger') && !invHtml.includes('does not match the accounts'),
);

const catRes = await fetch(`${base}/products/categories`, { headers: { cookie }, redirect: 'manual' });
const catHtml = catRes.status === 200 ? await catRes.text() : '';
check('GET /products/categories', catRes.status === 200, `status ${catRes.status}`);
check('lists seeded categories', catHtml.includes('Drinks') && catHtml.includes('Snacks'));

const adjRes = await fetch(`${base}/inventory/adjustments`, { headers: { cookie }, redirect: 'manual' });
const adjHtml = adjRes.status === 200 ? await adjRes.text() : '';
check('GET /inventory/adjustments', adjRes.status === 200, `status ${adjRes.status}`);
check('lists the opening stock document', adjHtml.includes('Opening stock'));

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
check('lists receipts', /RCP-\d+/.test(salesHtml));
check('shows profit column', salesHtml.includes('Profit'));
check('flags credit sales', salesHtml.includes('Credit'));

const posRes = await fetch(`${base}/sales/new`, { headers: { cookie }, redirect: 'manual' });
const posHtml = posRes.status === 200 ? await posRes.text() : '';
check('GET /sales/new (POS)', posRes.status === 200, `status ${posRes.status}`);
check('POS has product search', posHtml.includes('Find a product'));
check('POS offers payment methods', posHtml.includes('MTN MoMo'));

// Follow a real receipt through to its detail page and printable receipt.
const receiptMatch = /\/sales\/(\d+)"/.exec(salesHtml);
const someSaleId = receiptMatch?.[1];
check('found a sale to open', Boolean(someSaleId));
if (someSaleId) {
  const detail = await fetch(`${base}/sales/${someSaleId}`, { headers: { cookie }, redirect: 'manual' });
  const detailHtml = detail.status === 200 ? await detail.text() : '';
  check('GET /sales/[id]', detail.status === 200, `status ${detail.status}`);
  check('shows the accounting entry', detailHtml.includes('Accounting entry'));
  check('states the entry balances', detailHtml.includes('Debits equal credits'));
  check('shows cost of goods', detailHtml.includes('Cost of goods'));

  const receipt = await fetch(`${base}/sales/${someSaleId}/receipt`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const receiptHtml = receipt.status === 200 ? await receipt.text() : '';
  check('GET /sales/[id]/receipt', receipt.status === 200, `status ${receipt.status}`);
  check('receipt shows the shop name', appearsIn(receiptHtml, shopName), `looking for "${shopName}"`);
  check('receipt has a print control', receiptHtml.includes('Print'));
}

const custRes = await fetch(`${base}/customers`, { headers: { cookie }, redirect: 'manual' });
const custHtml = custRes.status === 200 ? await custRes.text() : '';
check('GET /customers', custRes.status === 200, `status ${custRes.status}`);
check('lists seeded customers', custHtml.includes('Ama Serwaa'));
check('shows total owed', custHtml.includes('Total owed to you'));

const custIdMatch = /\/customers\/(\d+)"/.exec(custHtml);
if (custIdMatch?.[1]) {
  const profile = await fetch(`${base}/customers/${custIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const profileHtml = profile.status === 200 ? await profile.text() : '';
  check('GET /customers/[id]', profile.status === 200, `status ${profile.status}`);
  check('profile shows what they owe', profileHtml.includes('Currently owes'));
}

console.log('\nPurchases & suppliers:');
const purRes = await fetch(`${base}/purchases`, { headers: { cookie }, redirect: 'manual' });
const purHtml = purRes.status === 200 ? await purRes.text() : '';
check('GET /purchases', purRes.status === 200, `status ${purRes.status}`);
check('lists purchase references', /PUR-\d+/.test(purHtml));
check('shows what is owed to suppliers', purHtml.includes('You owe suppliers'));
check('flags credit purchases', purHtml.includes('Credit'));

const newPurRes = await fetch(`${base}/purchases/new`, { headers: { cookie }, redirect: 'manual' });
const newPurHtml = newPurRes.status === 200 ? await newPurRes.text() : '';
check('GET /purchases/new', newPurRes.status === 200, `status ${newPurRes.status}`);
check('purchase form lists suppliers', newPurHtml.includes('Kasapreko'));

const purIdMatch = /\/purchases\/(\d+)"/.exec(purHtml);
if (purIdMatch?.[1]) {
  const detail = await fetch(`${base}/purchases/${purIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const detailHtml = detail.status === 200 ? await detail.text() : '';
  check('GET /purchases/[id]', detail.status === 200, `status ${detail.status}`);
  check('shows the accounting entry', detailHtml.includes('Accounting entry'));
  check('states the entry balances', detailHtml.includes('Debits equal credits'));
  check('offers a supplier return', detailHtml.includes('Return goods to this supplier'));
}

const supRes = await fetch(`${base}/suppliers`, { headers: { cookie }, redirect: 'manual' });
const supHtml = supRes.status === 200 ? await supRes.text() : '';
check('GET /suppliers', supRes.status === 200, `status ${supRes.status}`);
check('lists seeded suppliers', supHtml.includes('Madina Market Wholesale'));
check('shows total payable', supHtml.includes('Total you owe'));

const supIdMatch = /\/suppliers\/(\d+)"/.exec(supHtml);
if (supIdMatch?.[1]) {
  const profile = await fetch(`${base}/suppliers/${supIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const profileHtml = profile.status === 200 ? await profile.text() : '';
  check('GET /suppliers/[id]', profile.status === 200, `status ${profile.status}`);
  check('profile shows what you owe', profileHtml.includes('You currently owe'));
}

// A customer return must be offered on a real sale.
if (someSaleId) {
  const saleDetail = await fetch(`${base}/sales/${someSaleId}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const saleHtml = saleDetail.status === 200 ? await saleDetail.text() : '';
  check('sale offers a customer return', saleHtml.includes('Customer return'));
}

console.log('\nExpenses, income & accounts:');
const expRes = await fetch(`${base}/expenses`, { headers: { cookie }, redirect: 'manual' });
const expHtml = expRes.status === 200 ? await expRes.text() : '';
check('GET /expenses', expRes.status === 200, `status ${expRes.status}`);
check('lists seeded expenses', expHtml.includes('Shop rent for the month'));
check('groups spending by category', expHtml.includes('Where the money went'));
check('offers the expense form', expHtml.includes('Record an expense'));

const incRes = await fetch(`${base}/income`, { headers: { cookie }, redirect: 'manual' });
const incHtml = incRes.status === 200 ? await incRes.text() : '';
check('GET /income', incRes.status === 200, `status ${incRes.status}`);
check('lists other income', incHtml.includes('MoMo agent commission'));

const accRes = await fetch(`${base}/accounts`, { headers: { cookie }, redirect: 'manual' });
const accHtml = accRes.status === 200 ? await accRes.text() : '';
check('GET /accounts', accRes.status === 200, `status ${accRes.status}`);
check('lists money accounts', accHtml.includes('MTN MoMo') && accHtml.includes('Bank Account'));
check('shows total money held', accHtml.includes('Total money held'));
check('books report as balanced', !accHtml.includes('The books do not balance'));
check('no account is negative', !accHtml.includes('negative balance'));

const accIdMatch = /\/accounts\/(\d+)"/.exec(accHtml);
if (accIdMatch?.[1]) {
  const movements = await fetch(`${base}/accounts/${accIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const movHtml = movements.status === 200 ? await movements.text() : '';
  check('GET /accounts/[id]', movements.status === 200, `status ${movements.status}`);
  check('shows a running balance', movHtml.includes('Balance'));
  check('explains where the balance came from', movHtml.includes('why is the balance'));
  check('labels movement sources', /Expense|Sale|Purchase|Other income/.test(movHtml));
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
check('reports the books as healthy', acctHtml.includes('The books are healthy'));
check('NO integrity problems reported', !acctHtml.includes('Something is wrong with the books'));

const chartRes = await fetch(`${base}/accounting/chart`, { headers: { cookie }, redirect: 'manual' });
const chartHtml = chartRes.status === 200 ? await chartRes.text() : '';
check('GET /accounting/chart', chartRes.status === 200, `status ${chartRes.status}`);
check('lists real accounts', chartHtml.includes('Accounts Receivable') && chartHtml.includes('Inventory'));

const tbRes = await fetch(`${base}/accounting/trial-balance`, { headers: { cookie }, redirect: 'manual' });
const tbHtml = tbRes.status === 200 ? await tbRes.text() : '';
check('GET /accounting/trial-balance', tbRes.status === 200, `status ${tbRes.status}`);
check('trial balance balances', tbHtml.includes('The books balance'));

const jRes = await fetch(`${base}/accounting/journal`, { headers: { cookie }, redirect: 'manual' });
const jHtml = jRes.status === 200 ? await jRes.text() : '';
check('GET /accounting/journal', jRes.status === 200, `status ${jRes.status}`);
check('lists journal entries', /JE-\d+/.test(jHtml));
check('NO unbalanced entries flagged', !jHtml.includes('do not balance'));

const jIdMatch = /\/accounting\/journal\/(\d+)"/.exec(jHtml);
if (jIdMatch?.[1]) {
  const entry = await fetch(`${base}/accounting/journal/${jIdMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const entryHtml = entry.status === 200 ? await entry.text() : '';
  check('GET /accounting/journal/[id]', entry.status === 200, `status ${entry.status}`);
  check('entry shows debits equal credits', entryHtml.includes('Debits equal credits'));
}

const ledgerMatch = /\/accounting\/ledger\/(\d+)"/.exec(chartHtml);
if (ledgerMatch?.[1]) {
  const led = await fetch(`${base}/accounting/ledger/${ledgerMatch[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const ledHtml = led.status === 200 ? await led.text() : '';
  check('GET /accounting/ledger/[id]', led.status === 200, `status ${led.status}`);
  check('ledger shows a running balance', ledHtml.includes('Balance'));
}

const recRes = await fetch(`${base}/accounting/receivables`, { headers: { cookie }, redirect: 'manual' });
const recHtml = recRes.status === 200 ? await recRes.text() : '';
check('GET /accounting/receivables', recRes.status === 200, `status ${recRes.status}`);
check('ageing agrees with the ledger', !recHtml.includes('does not agree with the ledger'));
check('ageing shows buckets', recHtml.includes('Over 90'));

const payRes = await fetch(`${base}/accounting/payables`, { headers: { cookie }, redirect: 'manual' });
const payHtml = payRes.status === 200 ? await payRes.text() : '';
check('GET /accounting/payables', payRes.status === 200, `status ${payRes.status}`);
check('payables agree with the ledger', !payHtml.includes('does not agree with the ledger'));
check('lists a supplier owed', payHtml.includes('Madina Market Wholesale'));

console.log('\nReports:');
const repRes = await fetch(`${base}/reports`, { headers: { cookie }, redirect: 'manual' });
const repHtml = repRes.status === 200 ? await repRes.text() : '';
check('GET /reports', repRes.status === 200, `status ${repRes.status}`);
check('NO balance sheet warning', !repHtml.includes('does not balance'));

const plRes = await fetch(`${base}/reports/profit-and-loss?period=all`, {
  headers: { cookie },
  redirect: 'manual',
});
const plHtml = plRes.status === 200 ? await plRes.text() : '';
check('GET /reports/profit-and-loss', plRes.status === 200, `status ${plRes.status}`);
check('P&L shows gross and net profit', plHtml.includes('Gross profit') && plHtml.includes('Net profit'));
check('P&L shows cost of goods sold', plHtml.includes('Cost of goods sold'));

const bsRes = await fetch(`${base}/reports/balance-sheet`, { headers: { cookie }, redirect: 'manual' });
const bsHtml = bsRes.status === 200 ? await bsRes.text() : '';
check('GET /reports/balance-sheet', bsRes.status === 200, `status ${bsRes.status}`);
check('BALANCE SHEET BALANCES', bsHtml.includes('exactly equals what it owes'));
check('no balance warning shown', !bsHtml.includes('does not balance'));

const cfRes = await fetch(`${base}/reports/cash-flow?period=all`, { headers: { cookie }, redirect: 'manual' });
const cfHtml = cfRes.status === 200 ? await cfRes.text() : '';
check('GET /reports/cash-flow', cfRes.status === 200, `status ${cfRes.status}`);
check('cash flow reconciles', !cfHtml.includes('does not reconcile'));

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
check('inventory report matches the accounts', !invReportHtml.includes('does not match the accounts'));

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
check('lists past counts', /REC-\d+/.test(recoHtml));
check('shows what the books say vs counted', recoHtml.includes('Books say'));
check('shows the seeded shortage', recoHtml.includes('-3.50'));
check('explains the difference', recoHtml.includes('wrong change'));
check('marks the clean count as agreed', recoHtml.includes('Agreed'));
check('offers a count form', recoHtml.includes('Count an account'));
check('links to closing the books', recoHtml.includes('stops anything being added behind it'));

// The shortage must be visible as a cost on the P&L, not absorbed silently.
const plReco = await fetch(`${base}/reports/profit-and-loss?period=all`, {
  headers: { cookie },
  redirect: 'manual',
});
const plRecoHtml = plReco.status === 200 ? await plReco.text() : '';
check('shortage shows on the P&L', plRecoHtml.includes('Cash Over / Short'));

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
check('owner sees the books lock control', lockHtml.includes('Books lock'));
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
check('lists both demo accounts', usersHtml.includes('Demo Owner') && usersHtml.includes('Ama'));
check('marks the signed-in person', usersHtml.includes('>You<'));
check('shows who holds a till PIN', usersHtml.includes('has a till PIN'));
check('shows roles', usersHtml.includes('Owner') && usersHtml.includes('Staff'));
check('offers NO delete control', !/Delete\s*(user|person|account)/i.test(usersHtml));

const staffRow = usersHtml.match(/\/users\/(\d+)"/);
if (staffRow) {
  const detail = await fetch(`${base}/users/${staffRow[1]}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  const detailHtml = detail.status === 200 ? await detail.text() : '';
  check('GET /users/[id]', detail.status === 200, `status ${detail.status}`);
  check('shows recent activity', detailHtml.includes('Recent activity'));
  check('detail page offers NO delete', !/Delete\s*(user|person|account)/i.test(detailHtml));
}

const newUserRes = await fetch(`${base}/users/new`, { headers: { cookie }, redirect: 'manual' });
const newUserHtml = newUserRes.status === 200 ? await newUserRes.text() : '';
check('GET /users/new', newUserRes.status === 200, `status ${newUserRes.status}`);
check('form has a permission matrix', newUserHtml.includes('perm:sales:view'));

console.log('\nAudit log:');
const auditRes = await fetch(`${base}/users/audit`, { headers: { cookie }, redirect: 'manual' });
const auditHtml = auditRes.status === 200 ? await auditRes.text() : '';
check('GET /users/audit', auditRes.status === 200, `status ${auditRes.status}`);
check('records exist', auditHtml.includes('Records found'));
check('shows sign-in events', auditHtml.includes('Signed in'));
// The seeding, selling and counting done in earlier stages must all be on record.
check('records who did what', auditHtml.includes('owner') || auditHtml.includes('Demo Owner'));
check(
  'leaks NO password or PIN',
  !auditHtml.includes('demo-owner-2026') &&
    !auditHtml.includes('demo-staff-2026') &&
    !auditHtml.includes('8351'),
);
check('states the log cannot be edited', auditHtml.includes('can be edited or removed'));

/** "Records found" from the stat block — the count the filter actually returned. */
function recordsFound(html) {
  const match = html.match(/Records found<\/[^>]+>\s*<[^>]+>(\d+)/);
  return match ? Number(match[1]) : NaN;
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
check('an empty result says so plainly', auditNoMatchHtml.includes('Nothing matches'));

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
  check('staff nav hides Settings', !staffProductsHtml.includes('>Settings<'));
  check('staff nav hides Users', !staffProductsHtml.includes('>Users<'));

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
  check('it names the area', noAccessHtml.includes('users'));
  check('it says nothing was changed', noAccessHtml.includes('nothing was changed'));
  check('it does NOT show a server error', !noAccessHtml.includes('Application error'));

  // A made-up area must not put arbitrary text on the page.
  const bogus = await fetch(`${base}/no-access?area=%3Cscript%3Ealert(1)%3C%2Fscript%3E`, {
    headers: { cookie: staffCookie },
    redirect: 'manual',
  });
  const bogusHtml = bogus.status === 200 ? await bogus.text() : '';
  check('an unknown area is not echoed back', !bogusHtml.includes('<script>alert(1)</script>'));
}

console.log('\nYear-end pack:');
const yeRes = await fetch(`${base}/reports/year-end`, { headers: { cookie }, redirect: 'manual' });
const yeHtml = yeRes.status === 200 ? await yeRes.text() : '';
check('GET /reports/year-end', yeRes.status === 200, `status ${yeRes.status}`);
check('names the shop', appearsIn(yeHtml, shopName));
check('states the period covered', yeHtml.includes('Financial statements for the year'));
check('has a profit and loss', yeHtml.includes('Profit and Loss'));
check('has a balance sheet', yeHtml.includes('Balance Sheet'));
check('has a trial balance', yeHtml.includes('Trial Balance'));
check("shows the movement in the owner's stake", yeHtml.includes("Movement in the Owner"));
check('has a cash flow', yeHtml.includes('Cash Flow'));
check('lists what customers owe', yeHtml.includes('Owed by Customers'));
check('lists what is owed to suppliers', yeHtml.includes('Owed to Suppliers'));
check('explains the basis of preparation', yeHtml.includes('Basis of preparation'));
check('states the checks performed', yeHtml.includes('Checks performed'));
// React separates adjacent text nodes with `<!-- -->` markers when it renders
// on the server, so "Trial balance {verdict}" arrives split. Strip the markers
// before matching, or correct output reads as a failure.
const yeText = yeHtml.replace(/<!--.*?-->/g, '');
// The pack must assert its own integrity, not merely present tidy numbers.
check('reports the trial balance as balancing', yeText.includes('Trial balance balances'));
check('does NOT report a broken book', !yeText.includes('DOES NOT BALANCE'));
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
check('CSV carries the checks', yeCsvBody.includes('CHECKS PERFORMED'));
// And that they actually passed — a pack that says "NO" is the thing to catch.
check('CSV reports the books as sound', !/,NO,/.test(yeCsvBody), 'a check reported NO');

console.log('\nSettings:');
const setRes = await fetch(`${base}/settings`, { headers: { cookie }, redirect: 'manual' });
const setHtml = setRes.status === 200 ? await setRes.text() : '';
check('GET /settings', setRes.status === 200, `status ${setRes.status}`);
check('shows the shop name', appearsIn(setHtml, shopName), `looking for "${shopName}"`);
check('offers currency', setHtml.includes('Currency code'));
check('offers tax', setHtml.includes('Charge tax on sales'));
check('offers stock policy', setHtml.includes('Allow selling stock you do not have'));
// The demo database has transactions, so the currency must be pinned.
check('currency is locked once there are transactions', setHtml.includes('currency is fixed'));
check('says changes are recorded', setHtml.includes('recorded in the audit log'));
// Tax is off in the demo shop. The tax fields must still be present in the
// form, or saving would submit no tax name and fail on a field nobody can see.
check('tax fields still submit when tax is off', setHtml.includes('name="taxLabel"'));
check('  and so does "prices include tax"', setHtml.includes('name="taxInclusive"'));
check('links to its own change history', setHtml.includes('entity=business_settings'));

// The nav promised this page with a "Soon" tag until it existed.
const dashForNav = await fetch(`${base}/dashboard`, { headers: { cookie } });
const dashNavHtml = await dashForNav.text();
check('Settings is no longer marked "Soon"', !/Settings[\s\S]{0,120}?Soon/.test(dashNavHtml));

console.log('\nHealth & backup (the no-terminal path):');
const healthRes = await fetch(`${base}/settings/health`, { headers: { cookie }, redirect: 'manual' });
const healthHtml = healthRes.status === 200 ? await healthRes.text() : '';
check('GET /settings/health', healthRes.status === 200, `status ${healthRes.status}`);
check('runs the readiness checks', healthHtml.includes('The books balance'));
check('offers a backup download', healthHtml.includes('/api/backup'));

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

console.log('\nWhen things are missing or wrong:');
const unknownPath = await fetch(`${base}/this-page-does-not-exist`, {
  headers: { cookie },
  redirect: 'manual',
});
const unknownHtml = unknownPath.status === 404 ? await unknownPath.text() : '';
check('unknown address returns 404', unknownPath.status === 404, `status ${unknownPath.status}`);
check('and explains rather than crashing', unknownHtml.includes('does not exist'));

// A path that matches no route at all falls to the root 404, outside the shell.
// One inside the shell should keep the navigation and say more.
const missingInShell = await fetch(`${base}/sales/99999999`, { headers: { cookie }, redirect: 'manual' });
const missingInShellHtml = missingInShell.status === 404 ? await missingInShell.text() : '';
check(
  'a missing record reassures that nothing was deleted',
  missingInShellHtml.includes('does not delete financial records'),
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
check('offers a password sign-in', loginPageHtml.includes('Password'));
check('offers a till PIN sign-in', loginPageHtml.includes('Till PIN'));

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
