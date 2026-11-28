/** Книга клерка с диска: читается один раз, как prompt.md. */

import yaml from 'js-yaml';
import { parseClerkBook, type ClerkBook } from '../../core/clerk.js';
import { loadPrompt } from '../_shared/canon.js';

let book: ClerkBook | null = null;

export function clerkBook(): ClerkBook {
  book ??= parseClerkBook(yaml.load(loadPrompt(import.meta.url, 'book.yaml')));
  return book;
}
