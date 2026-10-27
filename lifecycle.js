(function (root) {
  function createVisibilityTracker(trackVisibility) {
    let visibilityConfirmed = false;
    return entry => {
      const geometryVisible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      if (trackVisibility && entry.isVisible) visibilityConfirmed = true;
      return geometryVisible && (!trackVisibility || !visibilityConfirmed || entry.isVisible);
    };
  }
  function createController({ transport, snapshot, restore, pause, error, interrupted = () => {}, now = () => performance.now(),
    hidden = () => document.hidden, schedule = setInterval, cancel = clearInterval,
    defer = setTimeout, cancelDefer = clearTimeout, saveDelay = 400 }) {
    let revision = 0, owned = false, running = false, deadline = 0, failed = false, closed = false, generation = 0;
    let chain = Promise.resolve(), heartbeat = null, pendingSave = null, lastSaved = null, needsReclaim = false;
    // Debounced clicks skip an identical snapshot while the 6s deadline still has slack.
    // The heartbeat always posts so a late interval cannot expire a still-valid lease.
    const leaseRefreshAt = 3000;
    // Embedded loopback pages can have an untrusted ancestor (no randomUUID API).
    // getRandomValues still supplies cryptographically strong identifiers there.
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
    const owner = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    function clearWork() {
      if (heartbeat != null) cancel(heartbeat);
      if (pendingSave != null) cancelDefer(pendingSave);
      heartbeat = null; pendingSave = null;
    }
    function fail(e) {
      failed = true; running = false; clearWork();
      if (!closed) { pause(); error(e.message); }
      throw e;
    }
    function expired() {
      if (!owned || failed || now() < deadline) return false;
      owned = false; running = false; needsReclaim = true; generation++;
      clearWork();
      if (!closed) {
        pause();
        interrupted("Diner control paused after an interruption. Resume to check and reacquire control.");
      }
      return true;
    }
    function validateResult(result) {
      if (!result || !Number.isInteger(result.revision) || result.revision < 0) {
        throw new Error("Invalid diner state response. Close and reopen the canvas.");
      }
      return result;
    }
    function enqueue(action) {
      const task = chain.then(action);
      chain = task.catch(() => {});
      return task;
    }
    async function request(op, value) {
      const sent = now();
      const result = validateResult(await transport({ op, owner, revision, ...(value ? { snapshot: value } : {}) }));
      revision = result.revision;
      deadline = sent + 6000;
      // Release and an already-owned resume write snapshots outside save().
      // A claim does not, so a pre-release cache must not skip the next save.
      lastSaved = value ? JSON.stringify(value) : null;
      return result;
    }
    const api = {
      async load() {
        try {
          const result = validateResult(await transport());
          if (closed) return result;
          revision = result.revision;
          if (result.snapshot) restore(result.snapshot);
          return result;
        } catch (e) { return fail(e); }
      },
      resume() {
        expired();
        const requestedGeneration = generation;
        return enqueue(async () => {
          expired();
          if (failed || closed || hidden() || requestedGeneration !== generation) return false;
          try {
            if (needsReclaim) {
              const current = validateResult(await transport());
              if (closed || hidden() || requestedGeneration !== generation) return false;
              if (current.revision !== revision) {
                throw new Error("This game changed in another view. Close and reopen the canvas before starting a fresh shift.");
              }
            }
            if (!owned) await request("claim");
            else await request("save", snapshot());
            owned = true;
            if (expired()) return false;
            if (hidden() || closed || requestedGeneration !== generation) {
              await request("release", snapshot());
              owned = false;
              running = false;
              return false;
            }
            needsReclaim = false;
            running = true;
            if (heartbeat == null) heartbeat = schedule(() => api.save({ refresh: true }).catch(() => {}), 2000);
            return true;
          } catch (e) { return fail(e); }
        });
      },
      save(options) {
        if (expired() || !owned || failed || closed) return Promise.resolve();
        const requestedGeneration = generation;
        let value, encoded;
        try {
          value = snapshot();
          encoded = JSON.stringify(value);
        } catch (e) { return Promise.reject(e).catch(fail); }
        return enqueue(async () => {
          if (expired() || !owned || failed || closed || requestedGeneration !== generation) return;
          // Compare after earlier queued writes update lastSaved. An early return
          // would drop a later A while an in-flight B still held the previous A.
          if (!options?.refresh && encoded === lastSaved && deadline - now() > leaseRefreshAt) return;
          try { await request("save", value); expired(); }
          catch (e) { return fail(e); }
        });
      },
      saveSoon() {
        if (expired() || !owned || failed || closed) return;
        if (pendingSave != null) cancelDefer(pendingSave);
        pendingSave = defer(() => {
          pendingSave = null;
          api.save().catch(() => {});
        }, saveDelay);
      },
      pause() {
        expired();
        generation++;
        clearWork();
        running = false; pause();
        let value;
        try { value = snapshot(); } catch (e) { return Promise.reject(e).catch(fail); }
        return enqueue(async () => {
          if (expired() || !owned || failed) return;
          try { await request("release", value); owned = false; }
          catch (e) { return fail(e); }
        });
      },
      close() {
        const done = api.pause();
        closed = true;
        clearWork();
        return done;
      },
      canAdvance() {
        expired();
        if (!owned || !running || failed || closed || hidden()) return false;
        return true;
      },
      canEdit() {
        expired();
        return owned && !failed && !closed && !hidden();
      },
      identity: () => ({ owner }),
    };
    return api;
  }
  const api = { createController, createVisibilityTracker };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DinerLifecycle = api;
})(typeof window === "undefined" ? globalThis : window);
