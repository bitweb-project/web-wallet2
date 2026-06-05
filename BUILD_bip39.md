# bip39-bundle.min.js — Reproducible Build Guide

Browser bundle for BIP39 mnemonic generation/validation and BIP32 HD key derivation.
Uses `@scure/bip39` (wordlist included) and `@scure/bip32` — both Cure53 audited.
Entropy source: `crypto.getRandomValues` (OS CSPRNG, native in all modern browsers).

**Changelog vs previous version:**
- Updated `@scure/bip39` + `@scure/bip32`: `1.4.0` → `2.2.0`
- Entry file: `require()` (CJS) → `import` (ESM) — required for v2.x
- Wordlist import: suffix `.js` required in v2.x
- Bundle size reduced: ~114 kb → ~67 kb (shared `@noble/hashes`, no duplicates)
- `getRandomValues` in bundle: 9 → 3 (was two copies of `@noble/hashes`, now one)
- `seed.fill(0)` — 64-byte master seed zeroed immediately after `HDKey.fromMasterSeed()`
- `root.privateKey.fill(0)` + `root.chainCode.fill(0)` — root HDKey zeroed after child derivation
- `child.privateKey.fill(0)` + `child.chainCode.fill(0)` — child HDKey zeroed after key copy
- `child.privateKey.slice()` — returns an independent copy of the buffer
- Entry point: `var` → `const`/`let` throughout
- `--target=es2020` — targets modern browsers only; no ES5 transpilation
- **Added `entropyToPrivKey(entropyBytes, path)`** — derives private key directly from entropy without exposing the intermediate mnemonic string outside the bundle

---

## Requirements

| Tool     | Minimum version    | Verified build | Check            |
|----------|--------------------|----------------|------------------|
| Node.js  | **≥ 20.0.0**       | v24.15.0       | `node --version` |
| npm      | **≥ 10**           | 11.13.0        | `npm --version`  |
| Internet | registry.npmjs.org | —              | —                |

The SRI hash in Step 7 was produced on **Node v24.15.0 + npm 11.13.0**. Any environment satisfying the minimum versions will produce a functionally equivalent bundle.

---

## RNG Audit

| Library | RNG used | Source |
|---------|----------|--------|
| `@scure/bip39` | `crypto.getRandomValues` | `@noble/hashes/utils → randomBytes()` |
| `@scure/bip32` | **none** — only HMAC-SHA512 (deterministic KDF) | — |

**Verified in bundle (Node v24.15.0 + npm 11.13.0):**
- `getRandomValues` — **3 occurrences** in bundle. The count is tied to the exact Node + npm versions used during bundling; builds on other versions may differ by 1 occurrence. What matters is that the count is **> 0** and `Math.random` is **absent**.
- `Math.random` — absent (0 occurrences)
- `node:crypto` / `require('crypto')` — absent (0 occurrences)

**RNG chain in the browser:**

```
bip39.generateMnemonic()
  → randomBytes(16 or 32)                  ← @noble/hashes/utils
      → globalThis.crypto.getRandomValues  ← Web Crypto API
          → window.crypto
              → OS CSPRNG                  ← /dev/urandom (Linux), CryptGenRandom (Windows)
```

---

## Step 1 — Create working directory

```bash
mkdir bte-bip39-bundle
cd bte-bip39-bundle
npm init -y
```

---

## Step 2 — Install exact pinned versions

Install one package at a time for reliability:

```bash
npm install --save-exact @scure/bip39@2.2.0
npm install --save-exact @scure/bip32@2.2.0
npm install --save-exact esbuild@0.28.0
```

### What each package does

| Package | Version | Purpose | Repository |
|---------|---------|---------|------------|
| @scure/bip39 | 2.2.0 | BIP39 mnemonic generation/validation, entropy↔mnemonic conversion | github.com/paulmillr/scure-bip39 |
| @scure/bip32 | 2.2.0 | BIP32 HD key derivation — pure JS, Cure53 audited, Paul Miller | github.com/paulmillr/scure-bip32 |
| esbuild | 0.28.0 | Bundler: ESM+CJS → single browser file | github.com/evanw/esbuild |

### Expected integrity hashes (sha512, npm registry)

```
@scure/bip39@2.2.0
  sha512-T/Bj/YvYMNkIPq6EENO6/rcs2e7qTNuyoUXf0KBFDmp0ZDu0H2X4Lq6yC3i0c8PcWkov5EbW+yQZZbdMmk154A==

@scure/bip32@2.2.0
  sha512-zFr7t2F+a9+5tB7QbarF2HQNYrgjCNaoLAupZdKkrFMYMozJf5zqH2WJCQibMzm1qQ0QogrxVGO3qXfQDYMaQg==

esbuild@0.28.0
  sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==
```

### Automated integrity check

> **Note:** never use `node -e "..."` for scripts containing `!` — bash treats `!`
> inside double quotes as history expansion. Always save to a file first.

```bash
cat > check_integrity.js << 'EOF'
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const expected = {
  '@scure/bip39': 'sha512-T/Bj/YvYMNkIPq6EENO6/rcs2e7qTNuyoUXf0KBFDmp0ZDu0H2X4Lq6yC3i0c8PcWkov5EbW+yQZZbdMmk154A==',
  '@scure/bip32': 'sha512-zFr7t2F+a9+5tB7QbarF2HQNYrgjCNaoLAupZdKkrFMYMozJf5zqH2WJCQibMzm1qQ0QogrxVGO3qXfQDYMaQg==',
  'esbuild':      'sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==',
}
let ok = true
for (const [pkg, hash] of Object.entries(expected)) {
  const entry = lock.packages['node_modules/' + pkg]
  if (!entry) { console.log('MISSING:', pkg); ok = false; continue }
  if (entry.integrity !== hash) {
    console.log('HASH MISMATCH:', pkg)
    console.log('  expected:', hash)
    console.log('  got:     ', entry.integrity)
    ok = false
  } else {
    console.log('OK:', pkg + '@' + entry.version)
  }
}
if (ok) console.log('\n✅ All integrity hashes match')
else { console.log('\n❌ INTEGRITY CHECK FAILED — do not use this build'); process.exit(1) }
EOF

node check_integrity.js
```

Expected output:
```
OK: @scure/bip39@2.2.0
OK: @scure/bip32@2.2.0
OK: esbuild@0.28.0

✅ All integrity hashes match
```

---

## Step 3 — Create the entry point

> **Important:** v2.x is ESM-only. Use `import`, not `require()`.
> The wordlist path requires the `.js` suffix in v2.x.

Single quotes around `EOF` are required:

```bash
cat > entry_bip39.js << 'EOF'
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync, entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

window.bip39Bundle = {
  generateMnemonic: function(strength) {
    // strength: 128 = 12 words, 256 = 24 words
    // Internally calls crypto.getRandomValues(new Uint8Array(16 or 32))
    return generateMnemonic(wordlist, strength || 128)
  },
  validateMnemonic: function(mnemonic) {
    return validateMnemonic(mnemonic, wordlist)
  },
  mnemonicToPrivKey: function(mnemonic, path) {
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    // Zero the 64-byte master seed immediately after HDKey absorbs it.
    // Without this, seed stays in heap until GC collects it.
    seed.fill(0)
    const child = root.derive(path || "m/84'/0'/0'/0/0")
    // Zero root private key and chain code after child derivation is complete.
    if (root.privateKey) root.privateKey.fill(0)
    if (root.chainCode)  root.chainCode.fill(0)
    // .slice() returns an independent Uint8Array copy.
    // Caller MUST fill(0) the returned value after use.
    const privKey = child.privateKey.slice()
    // Zero child internal buffers after copying the key out.
    if (child.privateKey) child.privateKey.fill(0)
    if (child.chainCode)  child.chainCode.fill(0)
    return privKey
  },
  // entropyToPrivKey: Uint8Array(16|20|24|28|32) → Uint8Array(32)
  // Derives the private key directly from raw entropy bytes without ever
  // exposing the intermediate mnemonic string outside this function.
  // The mnemonic is a JS string (immutable, cannot be zeroed) — keeping it
  // inside the bundle closure means it never escapes to the caller's heap.
  // Caller MUST fill(0) the returned Uint8Array after use.
  entropyToPrivKey: function(entropyBytes, path) {
    const mnemonic = entropyToMnemonic(entropyBytes, wordlist)
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    seed.fill(0)
    const child = root.derive(path || "m/84'/738'/0'/0/0")
    if (root.privateKey) root.privateKey.fill(0)
    if (root.chainCode)  root.chainCode.fill(0)
    const privKey = child.privateKey.slice()
    if (child.privateKey) child.privateKey.fill(0)
    if (child.chainCode)  child.chainCode.fill(0)
    return privKey
  },
  // entropyToMnemonic: Uint8Array(16|20|24|28|32) → mnemonic string
  entropyToMnemonic: function(entropyBytes) {
    return entropyToMnemonic(entropyBytes, wordlist)
  },
  // mnemonicToEntropy: mnemonic string → Uint8Array
  mnemonicToEntropy: function(mnemonic) {
    return mnemonicToEntropy(mnemonic, wordlist)
  },
  wordlist: wordlist
}
EOF
```

---

## Step 4 — Build the bundle

`--target=es2020` targets Chrome 80+, Firefox 72+, Safari 13.1+.
No ES5 transpilation — BigInt, arrow functions, and classes are native.

```bash
./node_modules/.bin/esbuild entry_bip39.js \
  --bundle \
  --platform=browser \
  --target=es2020 \
  --outfile=bip39-bundle.min.js \
  --minify \
  --define:global=globalThis \
  '--banner:js=var process={env:{NODE_ENV:"production"},browser:true,version:"v20.0.0",versions:{},platform:"browser",nextTick:function(fn,a,b,c){return setTimeout(function(){fn(a,b,c)},0)},hrtime:function(){return[0,0]},exit:function(){},on:function(){return this}};'
```

Expected output:

```
  bip39-bundle.min.js  68.8kb

⚡ Done in ~10–50ms
```

> Exact size depends on Node/npm version. ~68–70 kb is the correct range.

---

## Step 5 — Verify RNG in bundle (security audit)

```bash
# getRandomValues must be present (3 occurrences in v2.x):
grep -o "getRandomValues" bip39-bundle.min.js | wc -l

# Math.random must be ABSENT:
if grep -q "Math\.random" bip39-bundle.min.js; then echo "❌ PROBLEM: Math.random found"; else echo "✅ OK: Math.random absent"; fi

# node:crypto must be ABSENT:
if grep -qE "node:crypto|require\(.*crypto" bip39-bundle.min.js; then echo "❌ PROBLEM: node:crypto found"; else echo "✅ OK: no node:crypto"; fi

# Confirm all getRandomValues calls go through globalThis.crypto:
grep -oE '.{30}getRandomValues.{30}' bip39-bundle.min.js
```

Expected output:
```
3
✅ OK: Math.random absent
✅ OK: no node:crypto
This.crypto:null;if(typeof e?.getRandomValues!="function")throw new Error("
<= 65536, got ${t}`);return e.getRandomValues(new Uint8Array(t))}var gr,Kn,
```

> `getRandomValues` = 0 means the bundle is broken.
> Any positive count is safe; `Math.random` being absent is the critical invariant.

---

## Step 6 — Test the bundle

> **Install jsdom only at this step** — after the bundle has been built and the
> RNG audit passed. jsdom is a test harness dependency only; it is not imported
> by entry_bip39.js and will never appear in the bundle regardless of install
> order, but keeping it out of `package.json` during Steps 1–5 makes the
> dependency audit unambiguous.

```bash
npm install --save-exact jsdom
```

Save the test file (single-quoted EOF prevents variable expansion):

```bash
cat > test_bip39.js << 'EOF'
// ============================================================
// FULL TEST SUITE — @scure/bip39 + @scure/bip32 2.2.0 (34 checks)
// ============================================================
const { JSDOM } = require('jsdom')
const fs         = require('fs')
const nodeCrypto = require('crypto')

// Minimal browser env
const dom = new JSDOM('', { url: 'http://localhost' })
global.window   = dom.window
global.document = dom.window.document
global.crypto   = {
  getRandomValues: (buf) => { buf.set(nodeCrypto.randomBytes(buf.length)); return buf }
}

// RNG call counter for audit
let rngCallCount = 0
const _origRng = global.crypto.getRandomValues.bind(global.crypto)
Object.defineProperty(global.crypto, 'getRandomValues', {
  value: function(buf) { rngCallCount++; return _origRng(buf) },
  writable: false, configurable: false
})

const BUNDLE = './bip39-bundle.min.js'
const code = fs.readFileSync(BUNDLE, 'utf8')
const fn   = new Function('window', 'document', 'crypto', code + '; return window.bip39Bundle;')
const b    = fn(global.window, global.document, global.crypto)

// ============================================================
let total = 0, passed = 0, failed = 0
const FAIL_DETAILS = []

function check(label, got, expected) {
  total++
  const ok = expected === undefined ? !!got : got === expected
  if (ok) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    const detail = `  ❌ ${label}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`
    console.log(detail)
    FAIL_DETAILS.push(detail)
  }
}

function section(title) { console.log(`\n─── ${title} ───`) }

// ============================================================
section('1. BUNDLE BASICS')
check('bip39Bundle defined',    typeof b === 'object')
check('wordlist length',        b.wordlist.length, 2048)

// ============================================================
section('2. RNG AUDIT')
const bundleText = fs.readFileSync(BUNDLE, 'utf8')
check('Math.random absent from bundle',  !bundleText.includes('Math.random'))
check('node:crypto absent from bundle',  !bundleText.match(/node:crypto|require\(.*crypto/))
const rngBefore = rngCallCount
b.generateMnemonic(128)
check('generateMnemonic calls getRandomValues', rngCallCount > rngBefore)

// ============================================================
section('3. generateMnemonic / validateMnemonic')
const m12 = b.generateMnemonic(128)
const m24 = b.generateMnemonic(256)
check('generateMnemonic 12 words',      m12.split(' ').length, 12)
check('generateMnemonic 24 words',      m24.split(' ').length, 24)
check('validateMnemonic valid',         b.validateMnemonic(m12), true)
check('validateMnemonic invalid',       b.validateMnemonic('wrong word list'), false)

// ============================================================
section('4. mnemonicToPrivKey — key material & memory safety')
const pk = b.mnemonicToPrivKey(m12)
check('privKey is Uint8Array',          pk instanceof global.window.Uint8Array)
check('privKey length 32',              pk.length, 32)

const pk2 = b.mnemonicToPrivKey(m12)
let same = true
for (let i = 0; i < 32; i++) if (pk[i] !== pk2[i]) { same = false; break }
check('deterministic derivation (same mnemonic → same key)', same)

const pk3 = b.mnemonicToPrivKey(m12)
pk3.fill(0)
const pk4 = b.mnemonicToPrivKey(m12)
let stillValid = false
for (let i = 0; i < 32; i++) if (pk4[i] !== 0) { stillValid = true; break }
check('fill(0) on result does not corrupt next call (.slice() works)', stillValid)
check('seed.fill(0) did not break derivation', stillValid)

const pk5 = b.mnemonicToPrivKey(m12)
let sameAsPk = true
for (let i = 0; i < 32; i++) if (pk5[i] !== pk[i]) { sameAsPk = false; break }
check('root+child fill(0) does not corrupt future independent calls', sameAsPk)

const pkCustom = b.mnemonicToPrivKey(m12, "m/44'/0'/0'/0/0")
check('custom path: length 32',         pkCustom.length, 32)
let diff = false
for (let i = 0; i < 32; i++) if (pkCustom[i] !== pk[i]) { diff = true; break }
check('custom path gives different key than default', diff)

// ============================================================
section('5. entropy ↔ mnemonic roundtrip')
const ent12 = b.mnemonicToEntropy(m12)
check('mnemonicToEntropy: returns Uint8Array',      ent12 instanceof global.window.Uint8Array)
check('entropy 12-word: 16 bytes',                  ent12.length, 16)
check('entropyToMnemonic roundtrip 12-word',         b.entropyToMnemonic(ent12) === m12)

const ent24 = b.mnemonicToEntropy(m24)
check('entropy 24-word: 32 bytes',                  ent24.length, 32)
check('entropyToMnemonic roundtrip 24-word',         b.entropyToMnemonic(ent24) === m24)

// ============================================================
section('6. RNG uniqueness')
const mA = b.generateMnemonic(256)
const mB = b.generateMnemonic(256)
check('two mnemonics differ',                        mA !== mB)
const pkA = b.mnemonicToPrivKey(mA)
const pkB = b.mnemonicToPrivKey(mB)
let pkDiff = false
for (let i = 0; i < 32; i++) if (pkA[i] !== pkB[i]) { pkDiff = true; break }
check('different mnemonics → different privkeys',    pkDiff)

// ============================================================
section('7. entropyToPrivKey')
const BTE_PATH = "m/84'/738'/0'/0/0"

const epk12 = b.entropyToPrivKey(ent12)
check('entropyToPrivKey: returns Uint8Array',        epk12 instanceof global.window.Uint8Array)
check('entropyToPrivKey: length 32',                 epk12.length, 32)

const epk12b = b.entropyToPrivKey(ent12)
let epkSame = true
for (let i = 0; i < 32; i++) if (epk12[i] !== epk12b[i]) { epkSame = false; break }
check('entropyToPrivKey: deterministic (same entropy → same key)', epkSame)

const twoStep = b.mnemonicToPrivKey(b.entropyToMnemonic(ent12), BTE_PATH)
const oneStep = b.entropyToPrivKey(ent12, BTE_PATH)
let consistent = true
for (let i = 0; i < 32; i++) if (oneStep[i] !== twoStep[i]) { consistent = false; break }
check('entropyToPrivKey matches entropyToMnemonic→mnemonicToPrivKey (BTE path)', consistent)

const epk24 = b.entropyToPrivKey(ent24, BTE_PATH)
check('entropyToPrivKey 24-word: length 32',         epk24.length, 32)
const twoStep24 = b.mnemonicToPrivKey(b.entropyToMnemonic(ent24), BTE_PATH)
let consistent24 = true
for (let i = 0; i < 32; i++) if (epk24[i] !== twoStep24[i]) { consistent24 = false; break }
check('entropyToPrivKey 24-word matches two-step',   consistent24)

const epkCustom = b.entropyToPrivKey(ent12, "m/44'/0'/0'/0/0")
check('entropyToPrivKey custom path: length 32',     epkCustom.length, 32)
let customDiff = false
for (let i = 0; i < 32; i++) if (epkCustom[i] !== epk12[i]) { customDiff = true; break }
check('entropyToPrivKey custom path gives different key than default', customDiff)

const epkZ = b.entropyToPrivKey(ent12, BTE_PATH)
epkZ.fill(0)
const epkAfterZ = b.entropyToPrivKey(ent12, BTE_PATH)
let notAllZero = false
for (let i = 0; i < 32; i++) if (epkAfterZ[i] !== 0) { notAllZero = true; break }
check('fill(0) on entropyToPrivKey result does not corrupt next call', notAllZero)

const ent12alt = new global.window.Uint8Array(16)
global.crypto.getRandomValues(ent12alt)
const epkAlt = b.entropyToPrivKey(ent12alt, BTE_PATH)
let entDiff = false
for (let i = 0; i < 32; i++) if (epkAlt[i] !== epk12[i]) { entDiff = true; break }
check('entropyToPrivKey: different entropy → different key', entDiff)

// ============================================================
console.log('\n' + '='.repeat(55))
console.log(`TOTAL: ${total}  ✅ PASSED: ${passed}  ❌ FAILED: ${failed}`)
if (failed > 0) {
  console.log('\nFAILED TESTS:')
  FAIL_DETAILS.forEach(d => console.log(d))
  console.log('\n❌ TESTS FAILED — do not deploy this build')
  process.exit(1)
} else {
  console.log('\n✅ ALL TESTS PASSED — bundle is safe to deploy')
}
EOF

node test_bip39.js
```

Expected output:
```
─── 1. BUNDLE BASICS ───
  ✅ bip39Bundle defined
  ✅ wordlist length

─── 2. RNG AUDIT ───
  ✅ Math.random absent from bundle
  ✅ node:crypto absent from bundle
  ✅ generateMnemonic calls getRandomValues

─── 3. generateMnemonic / validateMnemonic ───
  ✅ generateMnemonic 12 words
  ✅ generateMnemonic 24 words
  ✅ validateMnemonic valid
  ✅ validateMnemonic invalid

─── 4. mnemonicToPrivKey — key material & memory safety ───
  ✅ privKey is Uint8Array
  ✅ privKey length 32
  ✅ deterministic derivation (same mnemonic → same key)
  ✅ fill(0) on result does not corrupt next call (.slice() works)
  ✅ seed.fill(0) did not break derivation
  ✅ root+child fill(0) does not corrupt future independent calls
  ✅ custom path: length 32
  ✅ custom path gives different key than default

─── 5. entropy ↔ mnemonic roundtrip ───
  ✅ mnemonicToEntropy: returns Uint8Array
  ✅ entropy 12-word: 16 bytes
  ✅ entropyToMnemonic roundtrip 12-word
  ✅ entropy 24-word: 32 bytes
  ✅ entropyToMnemonic roundtrip 24-word

─── 6. RNG uniqueness ───
  ✅ two mnemonics differ
  ✅ different mnemonics → different privkeys

─── 7. entropyToPrivKey ───
  ✅ entropyToPrivKey: returns Uint8Array
  ✅ entropyToPrivKey: length 32
  ✅ entropyToPrivKey: deterministic (same entropy → same key)
  ✅ entropyToPrivKey matches entropyToMnemonic→mnemonicToPrivKey (BTE path)
  ✅ entropyToPrivKey 24-word: length 32
  ✅ entropyToPrivKey 24-word matches two-step
  ✅ entropyToPrivKey custom path: length 32
  ✅ entropyToPrivKey custom path gives different key than default
  ✅ fill(0) on entropyToPrivKey result does not corrupt next call
  ✅ entropyToPrivKey: different entropy → different key

=======================================================
TOTAL: 34  ✅ PASSED: 34  ❌ FAILED: 0

✅ ALL TESTS PASSED — bundle is safe to deploy
```

All 34 checks must show `✅` and the final line `ALL TESTS PASSED`.

---

## Step 7 — Compute your hashes and deploy

Bundle hashes depend on the build environment (Node + npm version). There is no
canonical hash — compute yours after building and record it as the reference for
future rebuilds on the same machine.

```bash
# Size:
wc -c bip39-bundle.min.js

# SRI hash:
echo "sha512-$(openssl dgst -sha512 -binary bip39-bundle.min.js | openssl base64 -A)"
```

**Verified hashes (Node v24.15.0 + npm 11.13.0):**
```
70482 bip39-bundle.min.js
sha512-lf8u51hdguRIFwjMOeQl4ux4IgedzdqTM3UjiXtgYnv8a4xiI1TpEZXAyN/RQLY7VsAQV+ycHQs+jvvAyRbScA==
```

---

## API reference

### window.bip39Bundle

```js
bip39Bundle.generateMnemonic(strength?: 128 | 256): string
  // strength 128 → 12 words, 256 → 24 words. Default: 128.
  // Internally calls crypto.getRandomValues(new Uint8Array(16 or 32)).

bip39Bundle.validateMnemonic(mnemonic: string): boolean
  // Returns true only if every word is in the BIP39 English wordlist
  // and the checksum is valid.

bip39Bundle.mnemonicToPrivKey(mnemonic: string, path?: string): Uint8Array
  // Returns a 32-byte private key. Default path: m/84'/0'/0'/0/0.
  // seed, root, and child buffers are zeroed internally.
  // Caller MUST fill(0) the returned Uint8Array after use.

bip39Bundle.entropyToPrivKey(entropyBytes: Uint8Array, path?: string): Uint8Array
  // Uint8Array(16|20|24|28|32) → Uint8Array(32).
  // Default path: m/84'/738'/0'/0/0 (BTE path).
  // The intermediate mnemonic string never leaves this function.
  // Caller MUST fill(0) the returned Uint8Array after use.

bip39Bundle.entropyToMnemonic(entropyBytes: Uint8Array): string
  // Uint8Array(16|20|24|28|32) → mnemonic string.

bip39Bundle.mnemonicToEntropy(mnemonic: string): Uint8Array
  // mnemonic string → Uint8Array (16 bytes for 12-word, 32 bytes for 24-word).

bip39Bundle.wordlist: string[]
  // BIP39 English wordlist, 2048 entries.
```
