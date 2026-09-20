/**
 * One build/apply queue. New edits replace the pending generation.
 * A stale in-flight build must not apply or restart processes.
 */
export function createGenerationQueue(options = {}) {
  let seq = options.initialSeq ?? 0;
  let current = options.current ?? null;
  let building = null;
  let pending = null;
  let applying = false;
  const listeners = [];

  function emit(event) {
    for (const listener of listeners) listener(event);
  }

  function nextGeneration(components, files) {
    seq += 1;
    return {
      id: `g${seq}`,
      seq,
      components: [...new Set(components)],
      files: [...new Set(files ?? [])],
      createdAt: (options.now ?? Date.now)(),
    };
  }

  return {
    on(listener) {
      listeners.push(listener);
    },
    get current() {
      return current;
    },
    get pending() {
      return pending;
    },
    get building() {
      return building;
    },
    enqueue(components, files) {
      const generation = nextGeneration(components, files);
      if (pending && !building) {
        pending = mergeGenerations(pending, generation);
      } else if (pending) {
        pending = mergeGenerations(pending, generation);
      } else {
        pending = generation;
      }
      emit({ type: 'queued', generation: pending });
      return pending;
    },
    takeBuild() {
      if (building || !pending) return null;
      building = pending;
      pending = null;
      emit({ type: 'build-start', generation: building });
      return building;
    },
    completeBuild(generation, result) {
      if (!building || building.id !== generation.id) {
        emit({ type: 'build-stale', generation, result });
        return { stale: true };
      }
      building = null;
      if (result.ok !== true) {
        emit({ type: 'build-failed', generation, result });
        return { stale: false, failed: true };
      }
      emit({ type: 'build-ok', generation, result });
      return { stale: false, failed: false, generation };
    },
    beginApply(generation) {
      if (applying) return false;
      if (pending && pending.seq > generation.seq) return false;
      if (building && building.seq > generation.seq) return false;
      applying = true;
      return true;
    },
    finishApply(generation, ok) {
      applying = false;
      if (ok) current = generation;
      emit({ type: ok ? 'applied' : 'apply-failed', generation });
    },
    isStale(generation) {
      if (pending && pending.seq > generation.seq) return true;
      if (building && building.seq > generation.seq) return true;
      return false;
    },
  };
}

function mergeGenerations(base, next) {
  return {
    id: next.id,
    seq: next.seq,
    components: [...new Set([...base.components, ...next.components])],
    files: [...new Set([...base.files, ...next.files])],
    createdAt: next.createdAt,
    superseded: base.id,
  };
}
