const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

// Execute the checked-out TypeScript, replacing only platform dependencies.
// Each test gets its own module cache, environment and in-memory storage.
function loadApp(overrides = {}, env = {}) {
  const cache = new Map();
  const storage = new Map();
  const native = {
    Platform: { OS: 'web', select: (options) => options.web ?? options.default },
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {} },
  };
  for (const name of ['View', 'Text', 'Image', 'ActivityIndicator', 'SafeAreaView']) {
    native[name] = function NativeElement({ children }) {
      return require('react').createElement('div', null, children);
    };
  }
  const stubs = {
    'react-native': native,
    'react-native-safe-area-context': native,
    'expo-constants': { expoConfig: null, platform: null, expoGoConfig: null },
    'expo-wechat': { default: {
      registerApp: async () => true,
      isWXAppInstalled: async () => true,
      addListener: () => ({ remove() {} }),
      pay: async () => true,
    } },
    '@react-native-async-storage/async-storage': {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => { storage.set(key, value); },
      removeItem: async (key) => { storage.delete(key); },
    },
    'react-native-markdown-display': function Markdown({ children }) {
      return require('react').createElement('div', null, children);
    },
    ...overrides,
  };
  const appProcess = { env: { NODE_ENV: 'development', ...env } };
  function load(relativePath) {
    const filename = path.resolve(root, relativePath);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = createRequire(filename);
    function appRequire(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (/\.(png|jpg)$/.test(name)) return 1;
      if (name.startsWith('@/') || name.startsWith('.')) {
        const base = name.startsWith('@/')
          ? path.join(root, name.slice(2))
          : path.resolve(path.dirname(filename), name);
        const target = [base, `${base}.ts`, `${base}.tsx`].find(
          (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        );
        if (target) return load(path.relative(root, target));
      }
      return localRequire(name);
    }
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    new Function('require', 'module', 'exports', 'process', '__DEV__', code)(
      appRequire, module, module.exports, appProcess, appProcess.env.NODE_ENV !== 'production'
    );
    return module.exports;
  }
  return { load, storage };
}

module.exports = { loadApp };
