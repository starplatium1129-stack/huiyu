import type { Page } from '@playwright/test'

export function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  const ignore = /favicon|ERR_CONNECTION_REFUSED|404|Failed to load resource.*50[23]|Content Security Policy.*fonts\.googleapis|net::ERR_|Transition was skipped/;
  page.on('pageerror', error => {
    if (!ignore.test(error.message)) errors.push(error.message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !ignore.test(message.text())) {
      errors.push(message.text());
    }
  });
  return errors;
}
