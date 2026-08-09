// Screenshot capture script for RVP ERP Guide
// Uses Playwright to log in and capture all 44 pages

const { chromium } = require('playwright');
const path = require('path');

const BASE = 'https://rvpindustries.co.in';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

const PAGES = [
  { name: '01-login',              route: '/login',                      needsLogout: true },
  { name: '02-home',               route: '/' },
  { name: '03-dashboard',          route: '/dashboard' },
  // Master Data
  { name: '04-parties',            route: '/parties' },
  { name: '05-brokers',            route: '/brokers' },
  // Purchases
  { name: '06-purchase-orders',    route: '/purchase-orders' },
  { name: '07-stock-in',           route: '/stock-in' },
  { name: '08-stock-in-detail',    route: '/purchases' },
  { name: '09-verification',       route: '/verification' },
  // Stock
  { name: '10-black-seed-stock',   route: '/stock/overview' },
  { name: '11-order-planner',      route: '/stock/price' },
  { name: '12-stock-by-date',      route: '/stock/date' },
  { name: '13-stock-by-location',  route: '/stock/location' },
  { name: '14-stock-transfer',     route: '/stock/transfer' },
  { name: '15-purchases-by-party', route: '/stock/party' },
  { name: '16-stock-by-state',     route: '/stock/state' },
  // Tools
  { name: '17-pappu-calculator',   route: '/pappu-calculator' },
  // Sales
  { name: '18-sale-orders',        route: '/sale-orders' },
  { name: '19-pappu-sales',        route: '/sales/pappu' },
  { name: '20-pappu-profit-loss',  route: '/sales/profit-loss' },
  { name: '21-husk',               route: '/sales/husk' },
  { name: '22-tps-brokens',        route: '/sales/tps' },
  { name: '23-byproducts',         route: '/sales/byproducts' },
  { name: '24-credit-debit-notes', route: '/sales/notes' },
  // Reports
  { name: '25-taxes',              route: '/reports/taxes' },
  { name: '26-irn-ewb',            route: '/reports/irn-ewb' },
  { name: '27-purchase-dues',      route: '/reports/purchase-dues' },
  { name: '28-payment-planner',    route: '/reports/payment-planner' },
  { name: '29-sale-dues',          route: '/reports/sale-dues' },
  { name: '30-freight-dues',       route: '/reports/freight-dues' },
  { name: '31-brokerage-report',   route: '/accounts/brokerage-ledger' },
  { name: '32-party-ledger',       route: '/accounts/party-ledger' },
  { name: '33-hamali-report',      route: '/accounts/hamali-ledger' },
  { name: '34-kata-report',        route: '/accounts/kata-fee-ledger' },
  { name: '35-income-expenses',    route: '/reports/expenses' },
  // Banking
  { name: '36-storage-loans',      route: '/loans' },
  // Transactions
  { name: '37-payments',           route: '/transactions/payments' },
  { name: '38-receipts',           route: '/transactions/receipts' },
  // Accounts
  { name: '39-chart-of-accounts',  route: '/accounts/chart-of-accounts' },
  { name: '40-balance-sheet',      route: '/accounts/balance-sheet' },
  { name: '41-profit-loss',        route: '/accounts/profit-loss' },
  { name: '42-general-journal',    route: '/accounts/journal-entries' },
  // Settings
  { name: '43-settings',           route: '/settings' },
  { name: '44-users',              route: '/users' },
];

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // --- Step 1: Capture Login page (before logging in) ---
  console.log('[1/44] Capturing login page...');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-login.png'), fullPage: true });
  console.log('  > 01-login.png');

  // --- Step 2: Log in ---
  console.log('Logging in...');
  await page.fill('input#username', 'admin');
  await page.fill('input#password', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/');
  await page.waitForTimeout(2000);
  console.log('  > Logged in successfully');

  // --- Step 3: Capture remaining pages ---
  for (let i = 1; i < PAGES.length; i++) {
    const { name, route } = PAGES[i];
    const num = String(i + 1).padStart(2, '0');
    console.log(`[${num}/44] Capturing ${name}...`);
    
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2500);
      
      // Scroll down slightly to trigger any lazy content, then back up
      await page.evaluate(() => { window.scrollTo(0, 300); });
      await page.waitForTimeout(500);
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await page.waitForTimeout(500);
      
      await page.screenshot({ 
        path: path.join(SCREENSHOT_DIR, `${name}.png`), 
        fullPage: true 
      });
      console.log(`  > ${name}.png`);
    } catch (err) {
      console.error(`  X Failed to capture ${name}: ${err.message}`);
    }
  }

  await browser.close();
  console.log('\nAll screenshots captured!');
})();
