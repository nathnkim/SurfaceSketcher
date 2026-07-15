// dialog.js — Electron does not implement window.prompt() (it throws
// "prompt() is not supported"), so this is the in-page substitute used
// anywhere the app needs free-text input (file/folder names, rename).

function promptDialog(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3></h3>
        <label>
          <input type="text" />
        </label>
        <div class="modal-actions">
          <button class="prompt-cancel">Cancel</button>
          <button class="prompt-ok">OK</button>
        </div>
      </div>
    `;
    overlay.querySelector('h3').textContent = message;
    const input = overlay.querySelector('input');
    input.value = defaultValue;
    document.body.appendChild(overlay);
    input.focus();
    input.select();

    function close(result) {
      document.body.removeChild(overlay);
      resolve(result);
    }
    overlay.querySelector('.prompt-ok').addEventListener('click', () => close(input.value));
    overlay.querySelector('.prompt-cancel').addEventListener('click', () => close(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
  });
}

window.promptDialog = promptDialog;
