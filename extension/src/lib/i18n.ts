export function t(key: string, ...subs: (string | number)[]): string {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}
