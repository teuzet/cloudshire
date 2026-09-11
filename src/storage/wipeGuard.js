/**
 * Защита живого мира от воскрешения после wipe.
 * Писатели (save*) и wipe сериализуются; после ротации принимается только новый worldId.
 */

import { getLogger } from '../log.js';

export function createWipeGuard() {
  return {
    liveWorldId: null,
    writeChain: Promise.resolve(),

    setLiveWorld(id) {
      this.liveWorldId = id ? String(id) : null;
    },

    async exclusive(fn) {
      const prev = this.writeChain;
      let release;
      this.writeChain = new Promise((resolve) => {
        release = resolve;
      });
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },

    acceptWorld(world) {
      if (!this.liveWorldId) return true;
      return Boolean(world?.id && String(world.id) === this.liveWorldId);
    },

    acceptDomain(domain) {
      if (!this.liveWorldId) return true;
      return Boolean(domain?.worldId && String(domain.worldId) === this.liveWorldId);
    },

    acceptConflux(conflux) {
      if (!this.liveWorldId) return true;
      return Boolean(conflux?.worldId && String(conflux.worldId) === this.liveWorldId);
    },

    acceptBinding(binding) {
      if (!this.liveWorldId) return true;
      if (!binding?.worldId) return true;
      return String(binding.worldId) === this.liveWorldId;
    },

    reject(kind, attempted) {
      getLogger().warn('storage.stale_write', {
        kind,
        attempted: attempted || null,
        liveWorldId: this.liveWorldId,
      });
      return false;
    },
  };
}
