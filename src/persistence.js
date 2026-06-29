// Talks to the server's /api/planner/current endpoint. Debounced autosave with a
// keepalive flush so a pending edit survives the tab closing.

const ENDPOINT = "/api/planner/current";
const SAVE_DELAY_MS = 450;

// Creates a persistence controller bound to:
//   getPayload()  -> the JSON-serializable state to save
//   onStatus(txt) -> called with human-readable save status
export function createPersistence({ getPayload, onStatus }) {
  let ready = false;
  let pending = false;
  let timer = null;

  function setStatus(text) {
    onStatus?.(text);
  }

  async function load(applyPayload) {
    try {
      const response = await fetch(ENDPOINT);
      if (response.status === 404) {
        ready = true;
        setStatus("Ready to save");
        return;
      }
      if (!response.ok) {
        throw new Error(`Load failed: ${response.status}`);
      }
      const record = await response.json();
      const applied = record?.payload ? applyPayload(record.payload) : false;
      ready = true;
      setStatus(applied ? "Loaded" : "Ready to save");
    } catch {
      ready = false;
      setStatus("Browser only");
    }
  }

  async function save() {
    if (!ready) {
      return;
    }
    window.clearTimeout(timer);
    pending = false;
    setStatus("Saving…");
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getPayload()),
      });
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }
      setStatus("Saved");
    } catch {
      pending = true; // stay dirty so a later flush retries
      setStatus("Save failed");
    }
  }

  function scheduleSave() {
    if (!ready) {
      return;
    }
    pending = true;
    setStatus("Saving…");
    window.clearTimeout(timer);
    timer = window.setTimeout(save, SAVE_DELAY_MS);
  }

  // Fire-and-forget flush for page hide/unload — keepalive lets it complete.
  function flush() {
    if (!ready || !pending) {
      return;
    }
    window.clearTimeout(timer);
    pending = false;
    fetch(ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getPayload()),
      keepalive: true,
    }).catch(() => {
      pending = true;
    });
  }

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush();
    }
  });

  return { load, scheduleSave, flush };
}

// Ask the server to look a peptide up via the AI endpoint.
export async function fetchPeptideInfo(name) {
  const response = await fetch(`/api/peptide-info?name=${encodeURIComponent(name)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Lookup failed (${response.status}).`);
  }
  return data;
}
