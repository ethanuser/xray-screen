// Sounds panel (start screen): pick an audio file from this device for any slot. Files are kept in
// this browser only (IndexedDB), so songs can be used without publishing them with the site.
import { SLOTS, SLOT_LABELS } from './sounds.js';
import { POSES, YOGA } from './game.js';
import { MOVES } from './moves.js';
import { getSound, putSound, deleteSound, poseKey } from './soundstore.js';

export function setupSoundPanel(bank) {
  const panel = document.getElementById('soundsPanel');
  const list = panel.querySelector('.rows');
  const groups = [
    ['Machine', SLOTS.map((s) => [s, SLOT_LABELS[s]])],
    ['Moves', MOVES.map((m) => [poseKey(m.name), m.name])],
    ['Poses', POSES.map((p) => [poseKey(p.name), p.name])],
    ['Yoga', YOGA.map((p) => [poseKey(p.name), p.name])],
  ];

  async function row(key, label) {
    const el = document.createElement('div');
    el.className = 'row';
    const name = Object.assign(document.createElement('span'), { className: 'label', textContent: label });
    const status = Object.assign(document.createElement('span'), { className: 'status' });
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'audio/*', hidden: true, id: `sound-${key}` });
    const choose = Object.assign(document.createElement('label'), { className: 'tool', htmlFor: input.id, textContent: 'Choose' });
    const clear = Object.assign(document.createElement('button'), { className: 'tool', type: 'button', textContent: 'Clear' });
    const refresh = async () => {
      const saved = await getSound(key);
      status.textContent = saved ? saved.name : 'none';
      el.classList.toggle('set', Boolean(saved));
      clear.hidden = !saved;
    };
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      await putSound(key, file, file.name);
      bank.forget(key);
      input.value = '';
      refresh();
    });
    clear.addEventListener('click', async () => { await deleteSound(key); bank.forget(key); refresh(); });
    el.append(name, status, choose, input, clear);
    await refresh();
    return el;
  }

  async function open() {
    const parts = [];
    for (const [title, items] of groups) {
      parts.push(Object.assign(document.createElement('h3'), { textContent: title }));
      for (const [key, label] of items) parts.push(await row(key, label));
    }
    list.replaceChildren(...parts);
    panel.hidden = false;
  }

  document.getElementById('soundsBtn').addEventListener('click', open);
  document.getElementById('closeSounds').addEventListener('click', () => { panel.hidden = true; });
}
