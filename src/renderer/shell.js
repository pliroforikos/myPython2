/* Shell τύπου Thonny: έξοδος προγράμματος, είσοδος μέσα στη ροή, REPL (>>>), links στα λάθη. */
(function (root) {
  'use strict';

  const MAX_NODES = 4000;
  const TB_LINE_RE = /^(\s*File ")(.+)(", line )(\d+)(.*)$/;

  class Shell {
    /**
     * handlers: onInput(text), onRepl(line), onLink(file, line), onInterrupt(), onHelp()
     */
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers;
      this.edit = null;
      this.mode = 'idle';          // idle | running | repl
      this.atPrompt = false;
      this.lastChar = '\n';
      this.history = [];
      this.histIdx = 0;
      this.pasteQueue = [];
      this.promptSpan = null;

      el.addEventListener('mouseup', () => {
        const sel = window.getSelection();
        if (this.edit && sel && sel.isCollapsed) this.focus();
      });
      el.addEventListener('keydown', (e) => {
        // πληκτρολόγηση οπουδήποτε στο Shell πηγαίνει στη γραμμή εισόδου
        if (this.edit && e.target !== this.edit && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          this.focus();
        }
      });
    }

    // ------------------------------------------------------------- έξοδος
    _append(node) {
      if (this.edit && this.edit.parentNode === this.el) this.el.insertBefore(node, this.edit);
      else this.el.appendChild(node);
    }

    _trim() {
      while (this.el.childNodes.length > MAX_NODES) {
        const first = this.el.firstChild;
        if (first === this.edit || first === this.promptSpan) break;
        this.el.removeChild(first);
      }
    }

    _scroll() {
      const el = this.el;
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }

    write(text, cls) {
      if (!text) return;
      cls = cls || 'out';
      const before = this.edit && this.edit.parentNode === this.el ? this.edit.previousSibling : this.el.lastChild;
      if (before && before.nodeType === 1 && before.className === cls && before !== this.promptSpan &&
          !before.dataset.fixed && before.textContent.length < 20000) {
        before.textContent += text;
      } else {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        this._append(span);
      }
      this.lastChar = text[text.length - 1];
      this.atPrompt = false;
      this._trim();
      this._scroll();
    }

    _ensureNewline() {
      if (this.lastChar !== '\n') this.write('\n', 'out');
    }

    // ------------------------------------------------------------- είσοδος
    _ensureEdit() {
      if (this.edit) return;
      const ed = document.createElement('span');
      ed.className = 'shell-edit';
      ed.contentEditable = 'plaintext-only';
      ed.spellcheck = false;
      ed.addEventListener('keydown', (e) => this._onKey(e));
      ed.addEventListener('paste', (e) => this._onPaste(e));
      this.el.appendChild(ed);
      this.edit = ed;
    }

    _removeEdit() {
      if (this.edit) {
        this.edit.remove();
        this.edit = null;
      }
    }

    focus() {
      if (!this.edit) return;
      this.edit.focus();
      const range = document.createRange();
      range.selectNodeContents(this.edit);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    hasFocus() {
      return this.el.contains(document.activeElement);
    }

    _onKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._submit(this.edit.textContent);
        return;
      }
      if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && !e.shiftKey) {
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && this.mode === 'running') {
          e.preventDefault();
          this.h.onInterrupt();
        }
        return;
      }
      if (this.mode === 'repl' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (!this.history.length) return;
        e.preventDefault();
        this.histIdx += e.key === 'ArrowUp' ? -1 : 1;
        this.histIdx = Math.max(0, Math.min(this.history.length, this.histIdx));
        this.edit.textContent = this.history[this.histIdx] || '';
        this.focus();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertText', false, '    ');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.edit.textContent = '';
      }
    }

    _onPaste(e) {
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      const lines = text.split('\n');
      if (lines.length === 1) {
        document.execCommand('insertText', false, text);
        return;
      }
      if (lines[lines.length - 1] === '') lines.pop();
      const first = this.edit.textContent + lines.shift();
      this.pasteQueue.push(...lines);
      this._submit(first);
    }

    _submit(text) {
      const mode = this.mode;
      this._removeEdit();
      if (mode === 'repl') {
        this.write(text + '\n', 'repl-input');
        if (text.trim()) {
          if (this.history[this.history.length - 1] !== text) this.history.push(text);
        }
        this.histIdx = this.history.length;
        this.mode = 'running';
        this._ensureEdit();
        this.h.onRepl(text);
      } else if (mode === 'running') {
        this.write(text + '\n', 'user-input');
        this._ensureEdit();
        this.focus();
        this.h.onInput(text);
      }
    }

    _drainPaste(asMode) {
      if (!this.pasteQueue.length) return false;
      const line = this.pasteQueue.shift();
      this.mode = asMode;
      this._submit(line);
      return true;
    }

    // ------------------------------------------------------------- καταστάσεις
    beginRun(name) {
      this._removeEdit();
      this.pasteQueue = [];
      if (this.atPrompt) {
        this.write(`%Run ${name}\n`, 'command');
      } else {
        this._ensureNewline();
        this.write('>>> ', 'prompt');
        this.write(`%Run ${name}\n`, 'command');
      }
      this.mode = 'running';
      this._ensureEdit();
    }

    requestInput() {
      this.mode = 'running';
      this._ensureEdit();
      if (this._drainPaste('running')) return;
      this.focus();
    }

    showPrompt(more) {
      const hadFocus = this.hasFocus();
      this._removeEdit();
      this._ensureNewline();
      this.write(more ? '... ' : '>>> ', 'prompt');
      this.atPrompt = !more;
      this.mode = 'repl';
      this._ensureEdit();
      if (this._drainPaste('repl')) return;
      if (hadFocus) this.focus();
    }

    stopped(message) {
      this._removeEdit();
      this.pasteQueue = [];
      this._ensureNewline();
      this.write(message + '\n', 'info');
      this.mode = 'idle';
    }

    info(message) {
      this._ensureNewline();
      this.write(message + '\n', 'info');
    }

    writeError(err, helpTitle) {
      this._ensureNewline();
      const lines = (err.traceback || `${err.exc_type}: ${err.message}`).split('\n');
      lines.forEach((line) => {
        const m = TB_LINE_RE.exec(line);
        if (m && !/^<.*>$/.test(m[2])) {
          const span = document.createElement('span');
          span.className = 'err';
          span.dataset.fixed = '1';
          span.appendChild(document.createTextNode(m[1]));
          const link = document.createElement('a');
          link.className = 'tb-link';
          link.textContent = m[2];
          link.title = 'Μετάβαση στη γραμμή ' + m[4];
          link.addEventListener('click', () => this.h.onLink(m[2], Number(m[4])));
          span.appendChild(link);
          span.appendChild(document.createTextNode(m[3]));
          const ln = document.createElement('a');
          ln.className = 'tb-link';
          ln.textContent = m[4];
          ln.addEventListener('click', () => this.h.onLink(m[2], Number(m[4])));
          span.appendChild(ln);
          span.appendChild(document.createTextNode(m[5] + '\n'));
          this._append(span);
        } else {
          this.write(line + '\n', 'err');
        }
      });
      if (helpTitle) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.dataset.fixed = '1';
        hint.textContent = `💡 ${helpTitle}`;
        hint.title = 'Δες την εξήγηση στον Βοηθό';
        hint.addEventListener('click', () => this.h.onHelp());
        this._append(hint);
        this.write('\n', 'out');
      }
      this.lastChar = '\n';
      this._scroll();
    }

    clear() {
      const prompt = this.atPrompt || this.mode === 'repl';
      const mode = this.mode;
      this.el.textContent = '';
      this.edit = null;
      this.lastChar = '\n';
      if (prompt && mode === 'repl') {
        this.showPrompt(false);
      } else if (mode === 'running') {
        this._ensureEdit();
      }
    }
  }

  root.Shell = Shell;
})(typeof self !== 'undefined' ? self : this);
