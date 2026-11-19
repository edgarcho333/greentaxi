import { test, expect, type Page } from '@playwright/test';

const android = 'Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const identity = { id: 1, name: 'სატესტო მძღოლი', login: '', phone: '599123456', capacity: 6 };
const calendar = { today: '2026-11-19', tomorrow: '2026-11-20' };
test.use({ userAgent: android, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  let loggedIn = false;
  await page.route('**/api/driver/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/driver/auth/login') loggedIn = true;
    if (path.endsWith('/auth/session') || path.endsWith('/auth/login')) {
      return route.fulfill({ json: { ...calendar, driver: loggedIn ? identity : null } });
    }
    if (path === '/api/driver/dashboard') return route.fulfill({ json: {
      ...calendar, driver: identity, date: calendar.today,
      days: Object.values(calendar).map(date => ({ date, working: true, assignedTime: null, assignmentActive: false })),
      bookings: [], trip: null, trips: [], bookingScope: 'trip',
    } });
    return route.fulfill({ status: 404, json: { error: 'Unexpected driver test request' } });
  });
});

function offer(page: Page) { return page.locator('[data-driver-install-offer]'); }

test('Android uses a real offered browser prompt and can fall back to manual instructions', async ({ page }) => {
  await page.goto('/driver');
  await expect(offer(page)).toBeVisible();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperties(event, {
      prompt: { value: async () => { document.body.dataset.installPromptCalls = String(Number(document.body.dataset.installPromptCalls ?? 0) + 1); } },
      userChoice: { value: Promise.resolve({ outcome: 'dismissed' }) },
    });
    window.dispatchEvent(event);
    document.body.dataset.installPromptPrevented = String(event.defaultPrevented);
  });
  await offer(page).getByRole('button', { name: 'დამატება', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-install-prompt-calls', '1');
  await expect(page.locator('body')).toHaveAttribute('data-install-prompt-prevented', 'true');
  await expect(offer(page).getByText('Samsung Internet', { exact: true })).toBeVisible();
  await expect(offer(page).getByRole('button', { name: 'როგორ დავამატო?', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(offer(page)).toHaveCount(0);
});

test('driver install metadata and worker have a driver scope and never cache API data', async ({ page, request }) => {
  await page.goto('/driver');
  const manifestLink = page.locator('head link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/driver.webmanifest');
  await expect(page.locator('head link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/driver-icons/apple-touch-icon.png');
  const manifest = await (await request.get('/driver.webmanifest')).json();
  expect(manifest).toMatchObject({ start_url: '/driver', scope: '/driver', display: 'standalone' });
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('image/png');
  }
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { scope: new URL(registration.scope).pathname, caches: await caches.keys() };
  });
  expect(worker).toEqual({ scope: '/driver', caches: [] });
  // The ordinary booking page does not advertise the driver app.
  await page.goto('/');
  await expect(page.locator('head link[rel="manifest"]')).toHaveCount(0);
});

test('dismissal survives reload, instructions can be reopened, and the offer returns after a week', async ({ page }) => {
  await page.goto('/driver');
  await offer(page).getByRole('button', { name: 'დამატების შეთავაზების დახურვა' }).click();
  await expect(offer(page)).toHaveCount(0);
  await page.reload();
  await expect(offer(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'მთავარ ეკრანზე დამატება', exact: true }).click();
  await expect(offer(page).getByText('Samsung Internet', { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('greentaxi_driver_install_dismissed_at', String(Date.now() - 8 * 24 * 60 * 60 * 1_000)));
  await page.reload();
  await expect(offer(page)).toBeVisible();
});

test('the driver keeps one install offer after logging in', async ({ page }) => {
  await page.goto('/driver');
  await expect(offer(page)).toHaveCount(1);
  await page.getByRole('textbox', { name: 'ტელეფონის ნომერი', exact: true }).fill(identity.phone);
  await page.getByRole('button', { name: 'შესვლა', exact: true }).click();
  await expect(page.locator('[data-driver-portal]')).toBeVisible();
  await expect(offer(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'ვმუშაობ', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Chrome manual instructions cover installation and shortcut creation in a normal tab', async ({ page }) => {
  await page.goto('/driver');
  await offer(page).getByRole('button', { name: 'როგორ დავამატო?', exact: true }).click();
  const browsers = offer(page).getByRole('group', { name: 'Android ბრაუზერი' });
  await expect(browsers.getByRole('button', { name: 'Chrome', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(offer(page)).toContainText('არა ინკოგნიტო');
  await expect(offer(page).locator('ol')).toContainText('Add to Home screen');
  await expect(offer(page).locator('ol')).toContainText('Create shortcut');
  await expect(offer(page)).toContainText('თუ გვერდი სხვა აპში გაიხსნა');
  // A local HTTP test origin must not generate an Android intent pretending to be HTTPS.
  await expect(offer(page).getByRole('link', { name: 'გახსნა Chrome-ში', exact: true })).toHaveCount(0);
});

test.describe('Samsung Internet', () => {
  test.use({ userAgent: `${android} SamsungBrowser/27.0` });
  test('defaults to Samsung bottom-menu instructions and lets a driver choose Chrome', async ({ page }) => {
    await page.goto('/driver');
    await offer(page).getByRole('button', { name: 'როგორ დავამატო?', exact: true }).click();
    const browsers = offer(page).getByRole('group', { name: 'Android ბრაუზერი' });
    await expect(browsers.getByRole('button', { name: 'Samsung Internet', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(offer(page).locator('ol')).toContainText('ქვედა');
    await expect(offer(page).locator('ol')).toContainText('Add page to');
    await expect(offer(page).locator('ol')).toContainText('Home screen');
    await browsers.getByRole('button', { name: 'Chrome', exact: true }).click();
    await expect(browsers.getByRole('button', { name: 'Chrome', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(offer(page).locator('ol')).toContainText('Create shortcut');
    await expect(offer(page).locator('ol')).not.toContainText('Add page to');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe('iPhone', () => {
  test.use({ userAgent: iphone });
  test('Safari instructions work without an Android prompt or APK download', async ({ page }) => {
    await page.goto('/driver');
    await offer(page).getByRole('button', { name: 'როგორ დავამატო?', exact: true }).click();
    await expect(offer(page).getByText('Safari', { exact: true })).toBeVisible();
    await expect(offer(page)).toContainText('Add to Home Screen');
    await expect(offer(page).getByRole('group', { name: 'Android ბრაუზერი' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Android აპის ჩამოტვირთვა' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test('the installed iPhone app does not offer another installation', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
    await page.goto('/driver');
    await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
    await expect(offer(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'მთავარ ეკრანზე დამატება', exact: true })).toHaveCount(0);
  });
});

test.describe('native driver APK', () => {
  test.use({ userAgent: `${android} GreenTaxiDriver/1.0` });
  test('the existing wrapper does not show a browser installation or register a worker', async ({ page }) => {
    await page.goto('/driver');
    await expect(page.getByRole('heading', { name: 'მძღოლის შესვლა', exact: true })).toBeVisible();
    await expect(offer(page)).toHaveCount(0);
    await expect(page.locator('head link[rel="manifest"]')).toHaveCount(0);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  });
});
