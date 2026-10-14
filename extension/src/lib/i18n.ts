export function t(key: string, ...subs: (string | number)[]): string {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

// chrome.i18n has no plural rules, so singular forms are separate messages
// named `<key>One`.
export function tCount(key: string, n: number): string {
  return n === 1 ? t(key + 'One') : t(key, n);
}
