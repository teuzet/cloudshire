/**
 * Дописки-модификаторы города выключены: постоянный след идёт в cityBrief
 * через maybeRewriteCityGenesis.
 */

export async function maybeAppendStoryCityModifier() {
  return null;
}

export async function maybeAppendMysteryCityModifier(opts = {}) {
  return maybeAppendStoryCityModifier(opts);
}
