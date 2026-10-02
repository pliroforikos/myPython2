/* Κεντρική λογική της εφαρμογής. */
(function (root) {
  'use strict';
  const api = root.api;
  const $ = (s) => document.querySelector(s);
  const ES = () => root.EditorSetup;

  const STARTER = [
    '# Το πρώτο μου πρόγραμμα σε Python 2.7',
    '# Πάτησε F5 ή το πράσινο κουμπί «Εκτέλεση».',
    '',
    'onoma = raw_input("Πώς σε λένε; ")',
    'print "Γεια σου,", onoma',
    '',
  ].join('\n');

  /** Φόρμα σχολίων με την οποία ξεκινά κάθε νέο αρχείο (η ημερομηνία συμπληρώνεται αυτόματα). */
  const HEADER_LINE = '#'.repeat(59);
  const HEADER_CURSOR_LINE = 3;   // η γραμμή «Άσκηση:», όπου πηγαίνει ο κέρσορας
  function newFileHeader() {
    const d = new Date();
    return [
      HEADER_LINE,
      `# Ημερομηνία: ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`,
      '# Άσκηση: ',
      '# Ονοματεπώνυμο: ',
      HEADER_LINE,
      '',
      '',
    ].join('\n');
  }

  const samePath =(a, b) => !!a && !!b && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
  const baseName = (p) => p.split(/[\\/]/).pop();

  const App = {
    monaco: null,
    editor: null,
    settings: null,
    tabs: [],
    active: null,
    untitledCount: 0,
    nextId: 1,
    running: false,
    runTab: null,
    runHadError: false,
    pythonVersion: null,
    checkTimer: null,

    // ================================================================ εκκίνηση
    async init(monaco) {
      this.monaco = monaco;
      this.settings = await api.settings.get();
      ES().init(monaco);
      document.body.className = this.settings.theme === 'dark' ? 'theme-dark' : 'theme-light';

      this.editor = monaco.editor.create($('#editor-host'), { ...ES().editorOptions(this.settings), model: null });
      this.marks = new (ES().ErrorMarks)(monaco, this.editor);
      this.editor.onDidChangeCursorPosition((e) => {
        $('#st-pos').textContent = `Γρ ${e.position.lineNumber}, Στ ${e.position.column}`;
      });
      // F5 / Ctrl+F2 και μέσα στον editor (για σιγουριά, αν δεν πιάσει το μενού)
      this.editor.addCommand(monaco.KeyCode.F5, () => this.run());

      this.shell = new root.Shell($('#shell'), {
        onInput: (text) => api.backend.input(text),
        onRepl: (line) => { this.setState('running', 'Εκτελείται εντολή…'); api.backend.repl(line); },
        onLink: (file, line) => this.gotoFileLine(file, line),
        onInterrupt: () => this.stop(),
        onHelp: () => this.showPanel('assistant', true),
      });
      this.vars = new root.Panels.VariablesView($('#vars'));
      this.assistant = new root.Panels.AssistantView($('#assistant'), {
        onGoto: (line, err) => {
          const tab = (err && this.tabForFile(err.location && err.location.filename)) || this.runTab || this.active;
          if (tab) { this.activate(tab); this.reveal(line); }
        },
      });

      this.applyLayout();
      this.applyFont();
      this.applyPanels();
      this.bindToolbar();
      this.bindSplitters();
      this.bindDrop();
      api.onMenu((id, arg) => this.onMenu(id, arg));
      api.backend.onMessage((msg) => this.onBackend(msg));

      await this.restoreSession();
      this.startShell();
      this.checkPython();
    },

    async restoreSession() {
      const files = this.settings.openFiles || [];
      for (const p of files) {
        if (await api.file.exists(p)) {
          const r = await api.file.read(p);
          if (!r.error) this.addTab({ path: r.path, content: r.content }, false);
        }
      }
      if (!this.tabs.length) {
        const first = !(this.settings.recentFiles || []).length;
        this.addTab({ content: newFileHeader() + (first ? STARTER : '') }, true);
        this.cursorToHeader();
      }
      const act = this.tabs.find((t) => samePath(t.path, this.settings.activeFile)) || this.tabs[0];
      this.activate(act);
    },

    async checkPython() {
      const info = await api.python.info();
      const st = $('#st-py');
      if (info.ok) {
        this.pythonVersion = info.version;
        st.textContent = `Python ${info.version}`;
        st.className = '';
        st.title = info.path;
        st.onclick = null;
      } else {
        st.textContent = info.error === 'notpy2' ? `⚠ Python ${info.version}: χρειάζεται 2.7` : '⚠ Δεν βρέθηκε Python 2.7';
        st.className = 'bad';
        st.title = 'Κλικ για ρυθμίσεις';
        st.onclick = () => this.openSettings();
        const r = await api.dialog.message({
          type: 'warning',
          title: 'Python 2.7',
          message: info.error === 'notpy2'
            ? `Η διαδρομή που έχει οριστεί είναι Python ${info.version}, όχι Python 2.7.`
            : 'Δεν βρέθηκε η Python 2.7 στον υπολογιστή.',
          detail: 'Η εφαρμογή χρειάζεται την Python 2.7 (συνήθως στο C:\\Python27\\python.exe). Όρισε τη διαδρομή από τις Ρυθμίσεις.',
          buttons: ['Ρυθμίσεις…', 'Αργότερα'],
          defaultId: 0,
        });
        if (r.response === 0) this.openSettings();
      }
    },

    // ================================================================ καρτέλες
    addTab({ path, content }, activate = true) {
      const monaco = this.monaco;
      let uri;
      if (path) uri = monaco.Uri.file(path);
      else uri = monaco.Uri.parse(`inmemory://untitled/${++this.untitledCount}.py`);
      let model = monaco.editor.getModel(uri);
      if (model) model.setValue(content);
      else model = monaco.editor.createModel(content, ES().LANG, uri);
      model.updateOptions({ tabSize: 4, insertSpaces: true });
      const tab = {
        id: this.nextId++,
        path: path || null,
        title: path ? baseName(path) : (this.untitledCount === 1 ? 'χωρίς τίτλο' : `χωρίς τίτλο ${this.untitledCount}`),
        model,
        savedVersion: model.getAlternativeVersionId(),
        viewState: null,
      };
      model.onDidChangeContent(() => this.onContentChange(tab));
      this.tabs.push(tab);
      if (activate) this.activate(tab);
      else this.renderTabs();
      this.scheduleCheck(tab, 50);
      this.persistSession();
      return tab;
    },

    activate(tab) {
      if (!tab) return;
      if (this.active && this.active !== tab) this.active.viewState = this.editor.saveViewState();
      this.active = tab;
      this.editor.setModel(tab.model);
      if (tab.viewState) this.editor.restoreViewState(tab.viewState);
      this.editor.focus();
      this.renderTabs();
      this.updateTitle();
      this.persistSession();
    },

    isDirty(tab) { return tab.model.getAlternativeVersionId() !== tab.savedVersion; },

    renderTabs() {
      const box = $('#tabs');
      box.textContent = '';
      for (const tab of this.tabs) {
        const el = document.createElement('div');
        el.className = 'tab' + (tab === this.active ? ' active' : '') + (this.isDirty(tab) ? ' dirty' : '') +
          (this.running && tab === this.runTab ? ' running' : '');
        el.title = tab.path || 'Δεν έχει αποθηκευτεί ακόμα';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = tab.title;
        const close = document.createElement('button');
        close.className = 'close';
        close.title = 'Κλείσιμο (Ctrl+W)';
        close.innerHTML = '<span>×</span>';
        close.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(tab); });
        el.append(name, close);
        el.addEventListener('mousedown', (e) => {
          if (e.button === 1) { e.preventDefault(); this.closeTab(tab); } else if (e.button === 0) this.activate(tab);
        });
        box.appendChild(el);
      }
      box.ondblclick = (e) => { if (e.target === box) this.newFile(); };
    },

    updateTitle() {
      const t = this.active;
      if (!t) return;
      document.title = `${t.title}${this.isDirty(t) ? ' ●' : ''} – Python 2.7 ΕΠΑΛ`;
      $('#st-file').textContent = t.path || '(δεν έχει αποθηκευτεί)';
    },

    async closeTab(tab) {
      if (this.isDirty(tab)) {
        this.activate(tab);
        const r = await api.dialog.unsaved([tab.title]);
        if (r === 'cancel') return;
        if (r === 'save' && !(await this.save(tab))) return;
      }
      const i = this.tabs.indexOf(tab);
      this.tabs.splice(i, 1);
      if (this.marks.model === tab.model) this.marks.clear();
      if (!this.tabs.length) this.addTab({ content: newFileHeader() }, false);
      if (this.active === tab) {
        this.active = null;
        this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
      } else {
        this.renderTabs();
      }
      tab.model.dispose();
      this.persistSession();
    },

    tabForFile(file) {
      if (!file) return null;
      return this.tabs.find((t) => samePath(t.path, file)) || null;
    },

    persistSession() {
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => {
        api.settings.set({
          openFiles: this.tabs.filter((t) => t.path).map((t) => t.path),
          activeFile: this.active && this.active.path,
        });
      }, 400);
    },

    onContentChange(tab) {
      if (this.marks.model === tab.model) this.marks.clear();
      this.renderTabsLazy();
      this.scheduleCheck(tab, 600);
    },

    renderTabsLazy() {
      if (this.tabsFrame) return;
      this.tabsFrame = requestAnimationFrame(() => {
        this.tabsFrame = null;
        this.renderTabs();
        this.updateTitle();
      });
    },

    scheduleCheck(tab, delay) {
      clearTimeout(tab.checkTimer);
      tab.checkTimer = setTimeout(async () => {
        if (tab.model.isDisposed()) return;
        ES().setCharMarkers(this.monaco, tab.model);
        if (!this.settings.liveCheck) { ES().setSyntaxMarkers(this.monaco, tab.model, null); return; }
        const version = tab.model.getVersionId();
        const res = await api.check(tab.model.getValue());
        if (tab.model.isDisposed() || tab.model.getVersionId() !== version) return;
        ES().setSyntaxMarkers(this.monaco, tab.model, res);
      }, delay);
    },

    // ================================================================ αρχεία
    newFile() {
      this.addTab({ content: newFileHeader() }, true);
      this.cursorToHeader();
    },

    /** Ο κέρσορας στο τέλος της γραμμής «Άσκηση:» της φόρμας. */
    cursorToHeader() {
      const model = this.editor.getModel();
      if (!model || model.getLineContent(HEADER_CURSOR_LINE) !== '# Άσκηση: ') return;
      this.editor.setPosition({ lineNumber: HEADER_CURSOR_LINE, column: model.getLineMaxColumn(HEADER_CURSOR_LINE) });
      this.editor.focus();
    },

    async open() {
      const files = await api.file.open();
      for (const f of files) this.openLoaded(f);
    },

    openLoaded(f) {
      const existing = this.tabForFile(f.path);
      if (existing) { this.activate(existing); return existing; }
      // αντικατάσταση μιας άδειας, ανέγγιχτης καρτέλας «χωρίς τίτλο»
      // (περιέχει μόνο τη φόρμα σχολίων που μπήκε αυτόματα)
      const blank = this.tabs.length === 1 && !this.tabs[0].path && !this.isDirty(this.tabs[0]) ? this.tabs[0] : null;
      const tab = this.addTab({ path: f.path, content: f.content }, true);
      if (blank) this.closeTab(blank);
      return tab;
    },

    async openPath(p) {
      const r = await api.file.read(p);
      if (r.error) {
        api.dialog.message({ type: 'error', title: 'Άνοιγμα', message: `Δεν ήταν δυνατό να ανοίξει το αρχείο:\n${p}`, detail: r.error });
        return null;
      }
      return this.openLoaded(r);
    },

    async save(tab) {
      tab = tab || this.active;
      if (!tab.path) return this.saveAs(tab);
      const r = await api.file.save(tab.path, tab.model.getValue());
      return this.afterSave(tab, r);
    },

    async saveAs(tab) {
      tab = tab || this.active;
      const suggested = tab.path || 'programma.py';
      const r = await api.file.saveAs(tab.model.getValue(), suggested);
      if (!r) return false;
      if (r.ok) {
        const other = this.tabs.find((t) => t !== tab && samePath(t.path, r.path));
        if (other) this.closeTab(other);
        tab.path = r.path;
        tab.title = baseName(r.path);
      }
      return this.afterSave(tab, r);
    },

    afterSave(tab, r) {
      if (!r.ok) {
        api.dialog.message({ type: 'error', title: 'Αποθήκευση', message: 'Η αποθήκευση απέτυχε.', detail: r.error || '' });
        return false;
      }
      tab.savedVersion = tab.model.getAlternativeVersionId();
      this.renderTabs();
      this.updateTitle();
      this.persistSession();
      return true;
    },

    gotoFileLine(file, line) {
      const tab = this.tabForFile(file);
      if (tab) { this.activate(tab); this.reveal(line); return; }
      api.file.exists(file).then(async (ok) => {
        if (!ok) return;
        const t = await this.openPath(file);
        if (t) this.reveal(line);
      });
    },

    reveal(line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
      const model = this.editor.getModel();
      const first = model.getLineContent(line).search(/\S/);
      this.editor.setPosition({ lineNumber: line, column: first >= 0 ? first + 1 : 1 });
      this.editor.focus();
    },

    // ================================================================ εκτέλεση
    setState(kind, text) {
      const el = $('#st-state');
      el.className = 'st-state ' + kind;
      el.textContent = {
        idle: '● Έτοιμο', running: '▶ Εκτελείται…', input: '⌨ Περιμένει είσοδο στο Shell', error: '✖ Λάθος',
      }[kind];
      if (text) el.textContent = (kind === 'error' ? '✖ ' : kind === 'running' ? '▶ ' : '● ') + text;
      document.body.classList.toggle('running', kind === 'running' || kind === 'input');
    },

    startShell() {
      this.running = false;
      this.awaitingReady = true;
      api.backend.shell();
    },

    async run() {
      const tab = this.active;
      if (!tab) return;
      if (!tab.path || (this.settings.saveBeforeRun && this.isDirty(tab))) {
        if (!tab.path) {
          await api.dialog.message({
            type: 'info', title: 'Αποθήκευση', message: 'Πριν από την πρώτη εκτέλεση, δώσε ένα όνομα στο πρόγραμμα.',
            detail: 'Χρησιμοποίησε λατινικούς χαρακτήρες και κατάληξη .py, π.χ. askisi1.py', buttons: ['Εντάξει'],
          });
        }
        if (!(await this.save(tab))) return;
      }
      this.marks.clear();
      this.running = true;
      this.runTab = tab;
      this.runHadError = false;
      this.vars.reset();
      this.vars.empty('Το πρόγραμμα εκτελείται…');
      this.shell.beginRun(tab.title);
      this.setState('running');
      $('#shell-sub').textContent = '';
      this.renderTabs();
      this.awaitingReady = true;
      api.backend.run(tab.path, tab.model.getValue());
    },

    stop() {
      const wasRunning = this.running;
      this.awaitingReady = true;
      api.backend.stop();
      this.running = false;
      this.renderTabs();
      if (wasRunning) {
        this.shell.stopped('Το πρόγραμμα διακόπηκε από τον χρήστη.');
        this.assistant.show(root.ErrorHelp.explainStop());
        this.vars.empty('Το πρόγραμμα διακόπηκε· οι μεταβλητές του χάθηκαν.');
      } else {
        this.shell.stopped('Επανεκκίνηση του Shell.');
        this.vars.empty('Οι μεταβλητές του προγράμματος θα εμφανιστούν εδώ μετά την εκτέλεση.');
      }
      this.setState('idle');
      this.startShell();
    },

    onBackend(msg) {
      // μηνύματα που ήταν «καθ' οδόν» από μια διεργασία που μόλις σταμάτησε
      if (this.awaitingReady && msg.type !== 'ready' && msg.type !== 'no_python') return;
      if (msg.type === 'ready') this.awaitingReady = false;
      switch (msg.type) {
        case 'ready':
          this.pythonVersion = msg.version;
          break;
        case 'started': {
          const reason = { declared: ' (από τη δήλωση coding)', tkinter: ' (λόγω Tkinter)', default: '' }[msg.reason] || '';
          $('#st-enc').textContent = `Ελληνικά: ${msg.encoding}${reason}`;
          break;
        }
        case 'out':
          this.shell.write(msg.text, msg.stream === 'stderr' ? 'stderr' : 'out');
          break;
        case 'input_request':
          this.setState('input');
          this.shell.requestInput();
          break;
        case 'error':
          this.onError(msg);
          break;
        case 'done':
          this.running = false;
          this.renderTabs();
          if (!this.runHadError) {
            this.setState('idle', 'Ολοκληρώθηκε');
            if (msg.ok) this.assistant.success();
          }
          break;
        case 'globals':
          this.vars.update(msg.vars || []);
          break;
        case 'prompt':
          if (!this.running && !$('#st-state').classList.contains('error')) this.setState('idle');
          this.shell.showPrompt(msg.more);
          break;
        case 'exit':
          this.running = false;
          this.renderTabs();
          this.shell.stopped(`Η διεργασία της Python τερμάτισε${msg.code ? ` (κωδικός ${msg.code})` : ''}. Νέο Shell…`);
          this.setState('idle');
          setTimeout(() => this.startShell(), 300);
          break;
        case 'no_python':
          this.running = false;
          this.renderTabs();
          this.shell.stopped('Δεν βρέθηκε η Python 2.7. Όρισε τη διαδρομή της από Αρχείο → Ρυθμίσεις.');
          this.setState('error', 'Δεν βρέθηκε Python 2.7');
          break;
        default:
          break;
      }
    },

    onError(err) {
      const repl = err.phase === 'repl';
      if (!repl) this.runHadError = true;
      const loc = err.location || {};
      const tab = repl ? null : (this.tabForFile(loc.filename) || (samePath(loc.filename, this.runTab && this.runTab.path) ? this.runTab : null));
      const ctx = { lines: tab ? tab.model.getLinesContent() : (repl && loc.line ? [loc.line] : []) };
      const help = root.ErrorHelp.explain(err, ctx);
      this.shell.writeError(err, help.title);
      this.assistant.show(help, repl ? null : err);
      if (tab && loc.lineno) {
        if (this.active !== tab) this.activate(tab);
        const line = help.line || loc.lineno;
        this.marks.show(tab.model, line, help.line ? null : loc.col, `${help.title}\n${err.exc_type}: ${err.message}`);
        this.editor.revealLineInCenterIfOutsideViewport(line);
      }
      if (!repl) this.setState('error', loc.lineno ? `Λάθος στη γραμμή ${help.line || loc.lineno}: ${help.title}` : help.title);
      if (!this.settings.showAssistant) {
        $('#shell-sub').textContent = '💡 Άνοιξε τον Βοηθό (F7) για εξήγηση';
      }
    },

    // ================================================================ μενού / toolbar
    bindToolbar() {
      document.querySelectorAll('[data-cmd]').forEach((b) => {
        b.addEventListener('click', () => this.onMenu(b.dataset.cmd));
      });
      $('#st-enc').textContent = `Ελληνικά: ${this.settings.stringEncoding}`;
    },

    editorAction(id) {
      this.editor.focus();
      this.editor.trigger('menu', id, null);
    },

    async onMenu(id, arg) {
      const ed = {
        undo: 'undo', redo: 'redo', selectAll: 'editor.action.selectAll', find: 'actions.find',
        replace: 'editor.action.startFindReplaceAction', gotoLine: 'editor.action.gotoLine',
        toggleComment: 'editor.action.commentLine', indent: 'editor.action.indentLines', outdent: 'editor.action.outdentLines',
      };
      if (ed[id]) { this.editorAction(ed[id]); return; }
      switch (id) {
        case 'new': this.newFile(); break;
        case 'open': this.open(); break;
        case 'openPath': this.openPath(arg); break;
        case 'save': this.save(); break;
        case 'saveAs': this.saveAs(); break;
        case 'closeTab': if (this.active) this.closeTab(this.active); break;
        case 'run': this.run(); break;
        case 'stop': this.stop(); break;
        case 'clearShell': this.shell.clear(); break;
        case 'fixQuotes': this.fixQuotes(); break;
        case 'zoomIn': this.setFont(this.settings.fontSize + 1); break;
        case 'zoomOut': this.setFont(this.settings.fontSize - 1); break;
        case 'zoomReset': this.setFont(16); break;
        case 'toggleTheme': this.updateSettings({ theme: this.settings.theme === 'dark' ? 'light' : 'dark' }); break;
        case 'toggleMinimap': this.updateSettings({ minimap: !this.settings.minimap }); break;
        case 'toggleWrap': this.updateSettings({ wordWrap: !this.settings.wordWrap }); break;
        case 'toggleWhitespace': this.updateSettings({ showWhitespace: !this.settings.showWhitespace }); break;
        case 'toggleVariables': this.updateSettings({ showVariables: !this.settings.showVariables }); break;
        case 'toggleAssistant': this.updateSettings({ showAssistant: !this.settings.showAssistant }); break;
        case 'encoding:cp1253': case 'encoding:utf-8': this.setEncoding(id.split(':')[1]); break;
        case 'example': { const r = await api.openExample(arg); if (r && !r.error) this.openLoaded(r); break; }
        case 'settings': this.openSettings(); break;
        case 'help': case 'shortcuts': $('#dlg-help').showModal(); break;
        case 'about':
          $('#about-info').textContent = `Python: ${this.pythonVersion || '—'} · ${this.settings.pythonPath || ''}`;
          $('#dlg-about').showModal();
          break;
        case 'requestClose': this.requestClose(); break;
        default: break;
      }
    },

    fixQuotes() {
      const model = this.editor.getModel();
      const text = model.getValue();
      const fixed = root.ErrorHelp.fixSuspicious(text);
      if (fixed === text) {
        api.dialog.message({ type: 'info', title: 'Διόρθωση εισαγωγικών', message: 'Δεν βρέθηκαν ειδικοί χαρακτήρες για διόρθωση.', buttons: ['Εντάξει'] });
        return;
      }
      this.editor.pushUndoStop();
      this.editor.executeEdits('fixQuotes', [{ range: model.getFullModelRange(), text: fixed }]);
      this.editor.pushUndoStop();
    },

    async requestClose() {
      const dirty = this.tabs.filter((t) => this.isDirty(t) && (t.path || t.model.getValue().trim()));
      if (dirty.length) {
        const r = await api.dialog.unsaved(dirty.map((t) => t.title));
        if (r === 'cancel') return;
        if (r === 'save') {
          for (const t of dirty) {
            this.activate(t);
            if (!(await this.save(t))) return;
          }
        }
      }
      clearTimeout(this.persistTimer);
      await api.settings.set({
        openFiles: this.tabs.filter((t) => t.path).map((t) => t.path),
        activeFile: this.active && this.active.path,
      });
      api.closeNow();
    },

    // ================================================================ ρυθμίσεις
    async updateSettings(patch) {
      Object.assign(this.settings, patch);
      await api.settings.set(patch);
      if ('theme' in patch) {
        document.body.className = this.settings.theme === 'dark' ? 'theme-dark' : 'theme-light';
        this.applyPanels();
      }
      this.editor.updateOptions(ES().editorOptions(this.settings));
      this.monaco.editor.setTheme(this.settings.theme === 'dark' ? 'idle-dark' : 'idle-light');
      if ('showVariables' in patch || 'showAssistant' in patch) this.applyPanels();
      if ('fontSize' in patch) this.applyFont();
      if ('liveCheck' in patch) this.tabs.forEach((t) => this.scheduleCheck(t, 10));
    },

    setFont(size) {
      size = Math.max(10, Math.min(32, size));
      this.updateSettings({ fontSize: size });
    },

    applyFont() {
      $('#shell').style.fontSize = `${Math.max(10, this.settings.fontSize - 1)}px`;
    },

    async setEncoding(enc) {
      await this.updateSettings({ stringEncoding: enc });
      $('#st-enc').textContent = `Ελληνικά: ${enc}`;
      this.tabs.forEach((t) => this.scheduleCheck(t, 10));
      if (!this.running) {
        this.shell.info(`Κωδικοποίηση ελληνικών: ${enc}. Επανεκκίνηση Shell.`);
        this.startShell();
      }
    },

    applyPanels() {
      document.body.classList.toggle('no-vars', !this.settings.showVariables);
      document.body.classList.toggle('no-assist', !this.settings.showAssistant);
      $('#btn-vars').classList.toggle('on', !!this.settings.showVariables);
      $('#btn-assist').classList.toggle('on', !!this.settings.showAssistant);
      if (this.settings.showAssistant) $('#shell-sub').textContent = '';
    },

    showPanel(which) {
      if (which === 'assistant' && !this.settings.showAssistant) this.updateSettings({ showAssistant: true });
      if (which === 'variables' && !this.settings.showVariables) this.updateSettings({ showVariables: true });
    },

    async openSettings() {
      const s = await api.settings.get();
      $('#set-python').value = s.pythonPath || '';
      $('#set-font').value = s.fontSize;
      $('#set-theme').value = s.theme;
      $('#set-encoding').value = s.stringEncoding;
      $('#set-save').checked = !!s.saveBeforeRun;
      $('#set-live').checked = !!s.liveCheck;
      const status = $('#set-python-status');
      status.textContent = '';
      status.className = '';
      const test = async () => {
        status.textContent = 'Έλεγχος…';
        status.className = '';
        const r = await api.python.test($('#set-python').value.trim());
        if (r.ok) { status.textContent = `✓ Python ${r.version}`; status.className = 'ok-text'; }
        else if (r.error === 'notpy2') { status.textContent = `✗ Αυτή είναι η Python ${r.version}· χρειάζεται η 2.7`; status.className = 'bad-text'; }
        else { status.textContent = '✗ Δεν βρέθηκε ή δεν εκτελείται'; status.className = 'bad-text'; }
      };
      $('#set-python-test').onclick = test;
      $('#set-python-browse').onclick = async () => {
        const p = await api.dialog.choosePython();
        if (p) { $('#set-python').value = p; test(); }
      };
      const dlg = $('#dlg-settings');
      dlg.returnValue = '';
      dlg.showModal();
      dlg.onclose = async () => {
        if (dlg.returnValue !== 'ok') return;
        const patch = {
          pythonPath: $('#set-python').value.trim(),
          fontSize: Math.max(10, Math.min(32, Number($('#set-font').value) || 16)),
          theme: $('#set-theme').value,
          saveBeforeRun: $('#set-save').checked,
          liveCheck: $('#set-live').checked,
        };
        const pyChanged = patch.pythonPath !== this.settings.pythonPath;
        const enc = $('#set-encoding').value;
        await this.updateSettings(patch);
        if (enc !== this.settings.stringEncoding) await this.setEncoding(enc);
        else if (pyChanged && !this.running) this.startShell();
        if (pyChanged) this.checkPython();
      };
    },

    // ================================================================ διάταξη
    applyLayout() {
      const L = this.settings.layout || {};
      if (L.shell) $('#shell-panel').style.height = `${L.shell}px`;
      if (L.side) $('#side').style.width = `${L.side}px`;
      if (L.vars) $('#vars-panel').style.height = `${L.vars}px`;
    },

    bindSplitters() {
      const drag = (splitter, dir, onMove, key) => {
        splitter.addEventListener('mousedown', (e) => {
          e.preventDefault();
          splitter.classList.add('dragging');
          document.body.classList.add(dir === 'h' ? 'dragging-h' : 'dragging-v');
          let last = null;
          const move = (ev) => { last = onMove(ev); };
          const up = () => {
            splitter.classList.remove('dragging');
            document.body.classList.remove('dragging-h', 'dragging-v');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            if (last != null) {
              this.settings.layout = { ...(this.settings.layout || {}), [key]: Math.round(last) };
              api.settings.set({ layout: this.settings.layout });
            }
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        });
      };
      drag($('#split-shell'), 'h', (e) => {
        const r = $('#center').getBoundingClientRect();
        const h = Math.max(70, Math.min(r.height - 140, r.bottom - e.clientY));
        $('#shell-panel').style.height = `${h}px`;
        return h;
      }, 'shell');
      drag($('#split-side'), 'v', (e) => {
        const r = $('#main').getBoundingClientRect();
        const w = Math.max(200, Math.min(r.width - 360, r.right - e.clientX));
        $('#side').style.width = `${w}px`;
        return w;
      }, 'side');
      drag($('#split-assist'), 'h', (e) => {
        const r = $('#side').getBoundingClientRect();
        const h = Math.max(60, Math.min(r.height - 90, e.clientY - r.top));
        $('#vars-panel').style.height = `${h}px`;
        return h;
      }, 'vars');
    },

    bindDrop() {
      document.addEventListener('dragover', (e) => { e.preventDefault(); });
      document.addEventListener('drop', async (e) => {
        e.preventDefault();
        for (const f of Array.from(e.dataTransfer.files || [])) {
          const p = api.pathForFile(f);
          if (p) await this.openPath(p);
        }
      });
    },
  };

  root.App = App;
})(typeof self !== 'undefined' ? self : this);
