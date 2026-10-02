# -*- coding: utf-8 -*-
"""Tests για το backend/runner.py. Τρέχουν με Python 2.7:

    C:\\Python27\\python.exe -m unittest discover -s tests -p "test_*.py"
"""
import os
import sys
import json
import shutil
import tempfile
import unittest
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(ROOT, 'backend', 'runner.py')
CHECKER = os.path.join(ROOT, 'backend', 'checker.py')


class Session(object):
    def __init__(self):
        self.p = subprocess.Popen([sys.executable, '-u', '-B', RUNNER],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE)
        self.messages = []
        ready = self.read()
        assert ready['type'] == 'ready', ready

    def send(self, **cmd):
        self.p.stdin.write(json.dumps(cmd) + '\n')
        self.p.stdin.flush()

    def read(self):
        line = self.p.stdout.readline()
        if not line:
            raise AssertionError('ο runner τερμάτισε: ' + self.p.stderr.read())
        msg = json.loads(line)
        self.messages.append(msg)
        return msg

    def until_prompt(self, inputs=()):
        inputs = list(inputs)
        while True:
            msg = self.read()
            if msg['type'] == 'input_request':
                self.send(cmd='input', text=inputs.pop(0))
            if msg['type'] == 'prompt':
                return msg

    def output(self, stream='stdout'):
        return u''.join(m['text'] for m in self.messages
                        if m['type'] == 'out' and m['stream'] == stream)

    def errors(self):
        return [m for m in self.messages if m['type'] == 'error']

    def last_globals(self):
        g = [m for m in self.messages if m['type'] == 'globals'][-1]
        return dict((v['name'], v) for v in g['vars'])

    def close(self):
        try:
            self.p.kill()
        except OSError:
            pass


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='epal_')
        self.s = Session()

    def tearDown(self):
        self.s.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_code(self, source, inputs=(), name='prog.py', encoding='cp1253'):
        path = os.path.join(self.tmp, name).decode(sys.getfilesystemencoding())
        self.path = path
        self.s.send(cmd='run', path=path, source=source, encoding=encoding)
        return self.s.until_prompt(inputs)

    def test_greek_print_and_len(self):
        self.run_code(u"name = 'Αθήνα'\nprint name, len(name)\n")
        self.assertEqual(self.s.output(), u'Αθήνα 5\n')
        self.assertEqual(self.s.errors(), [])
        g = self.s.last_globals()
        self.assertEqual(g['name']['repr'], u"'Αθήνα'")
        self.assertEqual(g['name']['len'], 5)

    def test_raw_input_and_input(self):
        self.run_code(u"x = raw_input('Όνομα: ')\nn = input('Αριθμός: ')\n"
                      u"print x.upper(), n * 2\n", inputs=[u'Kostas', u'21'])
        self.assertEqual(self.s.output(), u'Όνομα: Αριθμός: KOSTAS 42\n')
        req = [m for m in self.s.messages if m['type'] == 'input_request']
        self.assertEqual(len(req), 2)

    def test_greek_input(self):
        self.run_code(u"x = raw_input()\nprint len(x), x\n", inputs=[u'Αμυγδαλιά'])
        self.assertEqual(self.s.output(), u'9 Αμυγδαλιά\n')

    def test_syntax_error_location(self):
        self.run_code(u"x = 1\nif x > 0\n    print x\n")
        err = self.s.errors()[0]
        self.assertEqual(err['exc_type'], 'SyntaxError')
        self.assertEqual(err['location']['lineno'], 2)
        self.assertEqual(err['location']['col'], 8)
        self.assertIn(u'if x > 0', err['traceback'])

    def test_indentation_error(self):
        self.run_code(u"for i in range(3):\nprint i\n")
        err = self.s.errors()[0]
        self.assertEqual(err['exc_type'], 'IndentationError')
        self.assertEqual(err['location']['lineno'], 2)

    def test_runtime_traceback_hides_runner(self):
        self.run_code(u"def f(a):\n    return 10 / a\n\nprint f(0)\n")
        err = self.s.errors()[0]
        self.assertEqual(err['exc_type'], 'ZeroDivisionError')
        self.assertEqual([f['lineno'] for f in err['frames']], [4, 2])
        self.assertNotIn('runner.py', err['traceback'])
        self.assertEqual(err['location']['lineno'], 2)
        self.assertTrue(err['traceback'].startswith(u'Traceback (most recent call last):'))

    def test_name_error_from_input(self):
        self.run_code(u"name = input('Όνομα: ')\n", inputs=[u'Kostas'])
        err = self.s.errors()[0]
        self.assertEqual(err['exc_type'], 'NameError')
        self.assertTrue(err['from_input'])
        self.assertEqual(err['last_input'], u'Kostas')
        self.assertEqual(err['location']['lineno'], 1)

    def test_name_error_suggestions(self):
        self.run_code(u"athroisma = 0\nprint athrisma\n")
        err = self.s.errors()[0]
        self.assertFalse(err['from_input'])
        self.assertIn(u'athroisma', err['names'])

    def test_value_error_greek_message(self):
        self.run_code(u"x = int(raw_input())\n", inputs=[u'πέντε'])
        err = self.s.errors()[0]
        self.assertEqual(err['exc_type'], 'ValueError')
        self.assertIn(u'πέντε', err['message'])

    def test_relative_file_in_program_folder(self):
        self.run_code(u"f = open('data.txt', 'w')\nf.write('Γεια')\nf.close()\n"
                      u"print open('data.txt').read()\n")
        self.assertEqual(self.s.output(), u'Γεια\n')
        with open(os.path.join(self.tmp, 'data.txt'), 'rb') as f:
            self.assertEqual(f.read(), u'Γεια'.encode('cp1253'))

    def test_repl_after_run(self):
        self.run_code(u"x = 21\n")
        self.s.send(cmd='repl', line=u'x * 2')
        self.s.until_prompt()
        self.assertEqual(self.s.output(), u'42\n')
        self.s.send(cmd='repl', line=u'for i in range(2):')
        self.assertTrue(self.s.until_prompt()['more'])
        self.s.send(cmd='repl', line=u'    print i')
        self.assertTrue(self.s.until_prompt()['more'])
        self.s.send(cmd='repl', line=u'')
        self.s.until_prompt()
        self.assertEqual(self.s.output(), u'42\n0\n1\n')
        self.s.send(cmd='repl', line=u'y = 1 +')
        self.s.until_prompt()
        self.assertEqual(self.s.errors()[-1]['exc_type'], 'SyntaxError')
        self.assertEqual(self.s.errors()[-1]['phase'], 'repl')

    def test_tkinter_uses_utf8(self):
        self.run_code(u"import Tkinter\nprint 'Αθήνα'\n")
        started = [m for m in self.s.messages if m['type'] == 'started'][0]
        self.assertEqual(started['encoding'], 'utf-8')
        self.assertEqual(started['reason'], 'tkinter')
        self.assertEqual(self.s.output(), u'Αθήνα\n')

    def test_tkinter_window_mainloop(self):
        self.run_code(u"# -*- coding: utf-8 -*-\nfrom Tkinter import *\nroot = Tk()\n"
                      u"Label(root, text='Γεια σου').pack()\nroot.after(300, root.destroy)\n"
                      u"root.mainloop()\nprint 'τέλος'\n")
        self.assertEqual(self.s.errors(), [])
        self.assertEqual(self.s.output(), u'τέλος\n')
        g = self.s.last_globals()
        self.assertIn('root', g)
        self.assertNotIn('Label', g)   # ονόματα του `from Tkinter import *` κρύβονται

    def test_declared_coding_respected(self):
        self.run_code(u"# -*- coding: utf-8 -*-\nprint len('Αθήνα')\n")
        self.assertEqual(self.s.output(), u'10\n')

    def test_unencodable_character(self):
        self.run_code(u"print 'ok'\nprint '\u263a'\n")
        err = self.s.errors()[0]
        self.assertEqual(err['exc_type'], 'UnicodeEncodeError')
        self.assertEqual(err['location']['lineno'], 2)

    def test_student_module_import(self):
        with open(os.path.join(self.tmp, 'mymod.py'), 'wb') as f:
            f.write(u"def hello():\n    return 'Γεια σου'\n".encode('utf-8'))
        self.run_code(u"import mymod\nprint mymod.hello(), len(mymod.hello())\n")
        self.assertEqual(self.s.errors(), [])
        self.assertEqual(self.s.output(), u'Γεια σου 8\n')

    def test_star_import_hidden_from_variables(self):
        self.run_code(u"from math import *\nr = 2\nembadon = pi * r ** 2\n")
        g = self.s.last_globals()
        self.assertEqual(sorted(g), ['embadon', 'r'])

    def test_sys_exit_is_clean(self):
        self.run_code(u"import sys\nprint 1\nsys.exit()\nprint 2\n")
        self.assertEqual(self.s.output(), u'1\n')
        done = [m for m in self.s.messages if m['type'] == 'done'][0]
        self.assertTrue(done['ok'])

    def test_os_system_does_not_break_protocol(self):
        self.run_code(u"import os\nos.system('echo hi')\nprint 'after'\n")
        self.assertIn(u'after', self.s.output())


class CheckerTest(unittest.TestCase):
    def setUp(self):
        self.p = subprocess.Popen([sys.executable, '-u', '-B', CHECKER],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def tearDown(self):
        self.p.kill()

    def check(self, source):
        self.p.stdin.write(json.dumps({'id': 1, 'source': source, 'encoding': 'cp1253'}) + '\n')
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def test_ok(self):
        self.assertTrue(self.check(u"print 'Γεια'\n")['ok'])

    def test_missing_colon(self):
        r = self.check(u"x = 'α'\nwhile x\n    pass\n")
        self.assertFalse(r['ok'])
        self.assertEqual(r['lineno'], 2)
        self.assertEqual(r['col'], 7)


if __name__ == '__main__':
    unittest.main()
