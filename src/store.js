import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// A small JSON file store. Pass file: null for an in-memory store (tests).
export async function createStore({ file = null, defaults = {} } = {}) {
  let data = { events: {}, settings: {} };
  if (file) {
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  data.events ??= {};
  data.settings = { ...defaults, ...data.settings };

  let queue = Promise.resolve();

  function save() {
    if (!file) return Promise.resolve();
    const write = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, file);
    });
    queue = write.catch(() => {});
    return write;
  }

  return {
    getEvent: (id) => data.events[id] ?? null,
    listEvents: () =>
      Object.values(data.events).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    async putEvent(event) {
      data.events[event.id] = event;
      await save();
      return event;
    },
    getSettings: () => data.settings,
    async updateSettings(patch) {
      data.settings = { ...data.settings, ...patch };
      await save();
      return data.settings;
    },
    save,
  };
}
