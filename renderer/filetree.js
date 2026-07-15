// filetree.js — sidebar workspace tree: lists folders/.skx files under the
// chosen workspace root, and handles create/rename/delete/open.

function dirName(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(0, idx);
}

class FileTree {
  constructor(container, { onOpenFile }) {
    this.container = container;
    this.onOpenFile = onOpenFile;
    this.root = null;
    this.activePath = null;
    this.selectedDir = null; // target folder for New File / New Folder
    this.collapsedPaths = new Set();

    // Clicking empty space below the tree re-targets New File/Folder at
    // the workspace root (rows below stop propagation via being a
    // different e.target, so this only fires on the blank area itself).
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) {
        this.selectedDir = this.root;
        this.refresh();
      }
    });
  }

  async setRoot(root) {
    this.root = root;
    this.selectedDir = root;
    await this.refresh();
  }

  async refresh() {
    if (!this.root) {
      this.container.innerHTML = '<div style="padding:12px;color:#999;font-size:12px;">No workspace open. Click the folder icon above to choose one.</div>';
      return;
    }
    const tree = await window.api.workspace.tree(this.root);
    this.container.innerHTML = '';
    this.container.appendChild(this._renderNodes(tree));
  }

  _renderNodes(nodes) {
    const wrap = document.createElement('div');
    for (const node of nodes) {
      wrap.appendChild(this._renderNode(node));
    }
    return wrap;
  }

  _renderNode(node) {
    const el = document.createElement('div');
    el.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    if (node.type === 'file' && node.path === this.activePath) row.classList.add('active');
    if (node.type === 'folder' && node.path === this.selectedDir) row.classList.add('target-dir');

    const isCollapsed = node.type === 'folder' && this.collapsedPaths.has(node.path);
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.type === 'folder' ? (isCollapsed ? '▸' : '▾') : '📝';
    row.appendChild(icon);

    const label = document.createElement('span');
    label.textContent = node.type === 'file' ? node.name.replace(/\.skx$/, '') : node.name;
    row.appendChild(label);

    row.addEventListener('click', () => {
      if (node.type === 'file') {
        this.activePath = node.path;
        this.selectedDir = dirName(node.path);
        this.refresh();
        this.onOpenFile(node.path);
      } else {
        this.selectedDir = node.path;
        if (this.collapsedPaths.has(node.path)) this.collapsedPaths.delete(node.path);
        else this.collapsedPaths.add(node.path);
        this.refresh();
      }
    });

    row.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const action = await promptDialog(
        `"${node.name}" — type: rename, delete, or cancel`,
        'cancel'
      );
      if (action === 'rename') {
        const newName = await promptDialog('New name:', node.type === 'file' ? node.name.replace(/\.skx$/, '') : node.name);
        if (newName && newName.trim()) {
          await window.api.workspace.rename(node.path, newName.trim());
          await this.refresh();
        }
      } else if (action === 'delete') {
        await window.api.workspace.delete(node.path);
        await this.refresh();
      }
    });

    el.appendChild(row);

    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children' + (isCollapsed ? ' hidden' : '');
    if (node.type === 'folder' && node.children) {
      childrenEl.appendChild(this._renderNodes(node.children));
      el.appendChild(childrenEl);
    }

    return el;
  }

  async createFile() {
    if (!this.root) return null;
    const name = await promptDialog('New sketch name:', 'Untitled');
    if (!name || !name.trim()) return null;
    const filePath = await window.api.workspace.createFile(this.selectedDir || this.root, name.trim());
    await this.refresh();
    return filePath;
  }

  async createFolder() {
    if (!this.root) return;
    const name = await promptDialog('New folder name:', 'New Folder');
    if (!name || !name.trim()) return;
    await window.api.workspace.createFolder(this.selectedDir || this.root, name.trim());
    await this.refresh();
  }

  setActive(filePath) {
    this.activePath = filePath;
    this.refresh();
  }
}

window.FileTree = FileTree;
