/** Open the same driver page in Chrome after an explicit Android link tap. */
export function androidChromeIntent(origin: string): string | null {
  try {
    const source = new URL(origin);
    if (source.protocol !== 'https:' || source.username || source.password) return null;
    const driver = new URL('/driver', source.origin);
    return `intent://${driver.host}/driver#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(driver.href)};end`;
  } catch { return null; }
}
