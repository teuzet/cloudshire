import fs from 'node:fs';

/** Страница dev-клиента лежит рядом обычным HTML. */
export const PAGE = fs.readFileSync(new URL('./page.html', import.meta.url), 'utf8');
