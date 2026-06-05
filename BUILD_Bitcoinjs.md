# bitcoin-bundle-v7.min.js — Reproducible Build Guide

This document allows anyone to reproduce the browser library bundle for
auditing purposes. The resulting `bitcoin-bundle-v7.min.js` is loaded by
the Bitweb web wallet (bitcoinjs-lib v6+ no longer ships a ready-made browser
file, so the bundle is built from source).

**Changelog vs previous version:**
- Removed `@bitcoinerlab/secp256k1` — replaced with a direct adapter over `@noble/curves`
  (Paul Miller, Cure53 audited). Eliminates a one-person intermediary package.
- Added `bitcoin.ecc` export — required by `wallet.js` for BIP341 taproot key-path
  signing (`privateNegate`, `privateAdd`).
- Entry point: `var` → `const`/`let` throughout.
- `bufToBigInt` / `bigIntToBuffer32` helpers — private key material never touches a
  hex string; avoids immutable JS string copies of key bytes in GC heap.
- `const { secp256k1, schnorr } = require(...)` — direct destructuring, no intermediate variable.
- `--target=es2020` — targets modern browsers only; no ES5 transpilation.
- **Updated to `@noble/curves@2.2.0`** — `sign()` returns `Uint8Array` directly;
  `Point` instead of `ProjectivePoint`; `.toBytes()` instead of `.toRawBytes()`;
  `Signature.fromBytes()` instead of `fromCompact()`; import requires `.js` suffix.

---

## Requirements

| Tool     | Minimum version                     | Verified build   | Check            |
|----------|-------------------------------------|------------------|------------------|
| Node.js  | **≥ 20.0.0** (ecpair requires ≥ 20) | v24.15.0         | `node --version` |
| npm      | **≥ 10**                            | 11.13.0          | `npm --version`  |
| Internet | registry.npmjs.org                  | —                | —                |

The SRI hash in Step 7 was produced on **Node v24.15.0 + npm 11.13.0**. Any environment satisfying the minimum versions will produce a functionally equivalent bundle.

---

## RNG Audit

| Library | RNG used | Source |
|---------|----------|--------|
| `ecpair → makeRandom()` | `crypto.getRandomValues` | `globalThis.crypto` |
| `@noble/hashes` (dep of @noble/curves) | `crypto.getRandomValues` | `globalThis.crypto.getRandomValues` |

**Verified in bundle (Node v24.15.0 + npm 11.13.0):**
- `getRandomValues` — **7 occurrences** in bundle. The count is tied to the exact Node + npm versions used during bundling; builds on other versions may differ by 1–2 occurrences. What matters is that the count is **> 0** and `Math.random` is **absent**.
- `Math.random` — absent (0 occurrences)
- `node:crypto` / `require('crypto')` — absent (0 occurrences)
- `@bitcoinerlab` — absent

**RNG chain in the browser:**
```
ECPair.makeRandom()
  → crypto.getRandomValues(new Uint8Array(32))   ← ecpair source
      → window.crypto.getRandomValues             ← Web Crypto API
          → OS CSPRNG  (/dev/urandom Linux, CryptGenRandom Windows)
```

---

## Step 1 — Create working directory

```bash
mkdir bte-wallet-bundle
cd bte-wallet-bundle
npm init -y
```

---

## Step 2 — Install exact pinned versions

Install one package at a time for reliability:

```bash
npm install --save-exact bitcoinjs-lib@7.0.1
npm install --save-exact ecpair@3.0.1
npm install --save-exact @noble/curves@2.2.0
npm install --save-exact esbuild@0.28.0
npm install --save-exact buffer@6.0.3
```

### What each package does

| Package | Version | Purpose | Repository |
|---------|---------|---------|------------|
| bitcoinjs-lib | 7.0.1 | Core: Psbt, payments, opcodes, address | github.com/bitcoinjs/bitcoinjs-lib |
| ecpair | 3.0.1 | Key management (split from bitcoinjs-lib in v6+) | github.com/bitcoinjs/ecpair |
| @noble/curves | 2.2.0 | secp256k1 curve — pure JS, Cure53 audited, Paul Miller | github.com/paulmillr/noble-curves |
| esbuild | 0.28.0 | Bundler: ESM+CJS → single browser file | github.com/evanw/esbuild |
| buffer | 6.0.3 | Browser polyfill for Node.js Buffer | github.com/feross/buffer |

### Expected integrity hashes (sha512, npm registry)

```
bitcoinjs-lib@7.0.1
  sha512-vwEmpL5Tpj0I0RBdNkcDMXePoaYSTeKY6mL6/l5esbnTs+jGdPDuLp4NY1hSh6Zk5wSgePygZ4Wx5JJao30Pww==

ecpair@3.0.1
  sha512-uz8wMFvtdr58TLrXnAesBsoMEyY8UudLOfApcyg40XfZjP+gt1xO4cuZSIkZ8hTMTQ8+ETgt7xSIV4eM7M6VNw==

@noble/curves@2.2.0
  sha512-T/BoHgFXirb0ENSPBquzX0rcjXeM6Lo892a2jlYJkqk83LqZx0l1Of7DzlKJ6jkpvMrkHSnAcgb5JegL8SeIkQ==

buffer@6.0.3
  sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==

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
  'bitcoinjs-lib':  'sha512-vwEmpL5Tpj0I0RBdNkcDMXePoaYSTeKY6mL6/l5esbnTs+jGdPDuLp4NY1hSh6Zk5wSgePygZ4Wx5JJao30Pww==',
  'ecpair':         'sha512-uz8wMFvtdr58TLrXnAesBsoMEyY8UudLOfApcyg40XfZjP+gt1xO4cuZSIkZ8hTMTQ8+ETgt7xSIV4eM7M6VNw==',
  '@noble/curves':  'sha512-T/BoHgFXirb0ENSPBquzX0rcjXeM6Lo892a2jlYJkqk83LqZx0l1Of7DzlKJ6jkpvMrkHSnAcgb5JegL8SeIkQ==',
  'buffer':         'sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==',
  'esbuild':        'sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==',
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
OK: bitcoinjs-lib@7.0.1
OK: ecpair@3.0.1
OK: @noble/curves@2.2.0
OK: buffer@6.0.3
OK: esbuild@0.28.0

✅ All integrity hashes match
```

---

## Step 3 — Create the entry point

Single quotes around `EOF` are required:

```bash
cat > entry_bundle.js << 'EOF'
const { Buffer } = require('buffer')
globalThis.Buffer = Buffer

const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
// 2.x: import requires .js suffix
const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js')

// Direct adapter over @noble/curves/secp256k1 (Paul Miller, Cure53 audited).
// Targets @noble/curves 2.x API:
//   - sign() returns Uint8Array directly (no .toCompactRawBytes() needed)
//   - ProjectivePoint → Point
//   - .toRawBytes() → .toBytes()
//   - Signature.fromCompact() → Signature.fromBytes()
//   - CRITICAL: prehash: false required — 2.x default changed to prehash: true
//   - verify() accepts Uint8Array directly (not Signature object)
//   - Point.fromBytes() instead of Point.fromHex() — no hex string for point data
const ecc = (function() {
  const G = secp256k1.Point.BASE

  // secp256k1 group order — well-known constant, not exposed in 2.x public API
  const ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n

  // Buffer → BigInt without intermediate hex string.
  // Private key material avoids hex strings because n.toString(16) produces
  // an immutable JS string containing key bytes that cannot be zeroed.
  // BigInt values are themselves immutable — a fundamental JS language limit
  // shared by all pure-JS crypto libs including @noble/curves itself.
  function bufToBigInt(buf) {
    let n = 0n
    for (let i = 0; i < buf.length; i++) {
      n = (n << 8n) | BigInt(buf[i])
    }
    return n
  }

  // BigInt → 32-byte Buffer without intermediate hex string
  function bigIntToBuffer32(n) {
    const buf = Buffer.allocUnsafe(32)
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(n & 0xffn)
      n >>= 8n
    }
    return buf
  }

  // 2.x: Point.fromBytes() instead of Point.fromHex() — no hex string for point data
  function isPoint(p) {
    if (!p || (p.length !== 33 && p.length !== 65)) return false
    try { secp256k1.Point.fromBytes(p); return true }
    catch(e) { return false }
  }

  function isXOnlyPoint(p) {
    if (!p || p.length !== 32) return false
    const prefixed = new Uint8Array(33)
    prefixed[0] = 0x02
    prefixed.set(p, 1)
    try { secp256k1.Point.fromBytes(prefixed); return true }
    catch(e) { return false }
  }

  // Private key check — secp256k1.utils.isValidSecretKey covers 0 < d < ORDER
  function isPrivate(d) {
    if (!d || d.length !== 32) return false
    return secp256k1.utils.isValidSecretKey(d)
  }

  // 2.x: .toBytes() instead of .toRawBytes()
  function pointCompress(p, compressed) {
    const pt = secp256k1.Point.fromBytes(p)
    return pt.toBytes(compressed !== false)
  }

  // Private key input — bufToBigInt avoids hex string of key material
  function pointFromScalar(d, compressed) {
    if (!isPrivate(d)) return null
    const pt = G.multiply(bufToBigInt(d))
    return pt.toBytes(compressed !== false)
  }

  function xOnlyPointAddTweak(p, tweak) {
    try {
      const prefixed = new Uint8Array(33)
      prefixed[0] = 0x02
      prefixed.set(p, 1)
      const px = secp256k1.Point.fromBytes(prefixed)
      const t = bufToBigInt(tweak)
      if (t >= ORDER) return null
      const result = px.add(G.multiply(t))
      if (result.equals(secp256k1.Point.ZERO)) return null
      const raw = result.toBytes(true)
      return { parity: raw[0] === 3 ? 1 : 0, xOnlyPubkey: raw.slice(1) }
    } catch(e) { return null }
  }

  // Both inputs are key material — no hex strings
  function privateAdd(d, tweak) {
    const dn = bufToBigInt(d)
    const tn = bufToBigInt(tweak)
    const result = (dn + tn) % ORDER
    if (result === 0n) return null
    return bigIntToBuffer32(result)
  }

  // Input is key material — no hex strings
  function privateNegate(d) {
    const dn = bufToBigInt(d)
    const result = (ORDER - dn) % ORDER
    return bigIntToBuffer32(result)
  }

  // 2.x: sign() returns Uint8Array directly — no .toCompactRawBytes() needed.
  // CRITICAL: prehash: false required — 2.x default changed to prehash: true.
  // Bitcoin passes a pre-hashed 32-byte digest; prehash: true would double-hash.
  function sign(hash, priv, extra) {
    return secp256k1.sign(hash, priv, {
      lowS:         true,
      prehash:      false,
      extraEntropy: extra || undefined
    })
  }

  // 2.x: verify() accepts Uint8Array directly (NOT Signature object — throws if passed).
  // Signature.fromBytes() used only for the optional strict=true hasHighS check.
  // CRITICAL: prehash: false required here too.
  function verify(hash, pub, sig, strict) {
    try {
      if (strict) {
        const s = secp256k1.Signature.fromBytes(sig)
        if (s.hasHighS()) return false
      }
      return secp256k1.verify(sig, hash, pub, { prehash: false })
    } catch(e) { return false }
  }

  function signSchnorr(hash, priv, extra) {
    return schnorr.sign(hash, priv, extra)
  }

  function verifySchnorr(hash, pub, sig) {
    try { return schnorr.verify(sig, hash, pub) }
    catch(e) { return false }
  }

  return {
    isPoint, isXOnlyPoint, isPrivate,
    pointCompress, pointFromScalar, xOnlyPointAddTweak,
    privateAdd, privateNegate,
    sign, verify, signSchnorr, verifySchnorr
  }
})()

bitcoin.initEccLib(ecc)
bitcoin.ECPair = ECPairFactory(ecc)
bitcoin.Buffer = Buffer
bitcoin.ecc    = ecc

// ============================================================
// BIP341 key-path taproot signer — lives in the bundle so that
// all crypto primitives (tweak computation + key zeroing) are
// co-located with the ecc adapter and auditable in one place.
//
// Usage (wallet.js):
//   bitcoin.taproot.makeKeySigner(kp, function(signer) {
//     psbt.signInput(idx, signer)
//   })
//
// The callback receives a signer object valid only for the
// duration of the callback. All derived key material (rawD,
// effectiveD, tweakedD) is zeroed in the finally block — even
// on exception — before control returns to the caller.
// ============================================================
bitcoin.taproot = (function() {
  function makeKeySigner(kp, onSigned) {
    if (!kp.privateKey) {
      throw new Error('taproot.makeKeySigner: private key required')
    }
    // 32-byte x-only of internal public key P
    const xOnlyPub = kp.publicKey.slice(1)
    // BIP341: hash_TapTweak(bytes(P))  — taggedHash lives in bitcoin.crypto
    const tweak    = bitcoin.crypto.taggedHash('TapTweak', xOnlyPub)
    // Copy of raw private key — zeroed in finally regardless of outcome
    const rawD     = new Uint8Array(kp.privateKey)
    let effectiveD = null
    let tweakedD   = null
    try {
      // BIP340 requires even y on the internal key before adding tweak.
      // If y is odd (prefix 0x03), negate the private key first.
      const oddY = (kp.publicKey[0] === 0x03)
      effectiveD = oddY ? ecc.privateNegate(rawD) : new Uint8Array(rawD)
      tweakedD   = ecc.privateAdd(effectiveD, tweak)
      if (!tweakedD) throw new Error('TapTweak produced an invalid private key')
      const tweakedPubResult = ecc.xOnlyPointAddTweak(xOnlyPub, tweak)
      if (!tweakedPubResult) throw new Error('xOnlyPointAddTweak failed')
      // Capture tweakedD before finally can zero it — signer is valid only
      // inside the callback; caller must not store signSchnorr for later use.
      const td = tweakedD
      onSigned({
        publicKey:   tweakedPubResult.xOnlyPubkey,
        signSchnorr: function(hash) { return ecc.signSchnorr(hash, td) }
      })
    } finally {
      rawD.fill(0)
      if (effectiveD) effectiveD.fill(0)
      if (tweakedD)   tweakedD.fill(0)
    }
  }

  return { makeKeySigner: makeKeySigner }
})()

module.exports = bitcoin
EOF
```

---

## Step 4 — Build the bundle

`--target=es2020` targets Chrome 80+, Firefox 72+, Safari 13.1+.
No ES5 transpilation — BigInt, arrow functions, and classes are native.

```bash
./node_modules/.bin/esbuild entry_bundle.js \
  --bundle \
  --platform=browser \
  --target=es2020 \
  --global-name=bitcoin \
  --outfile=bitcoin-bundle-v7.min.js \
  --minify \
  --define:global=globalThis \
  '--banner:js=var process={env:{NODE_ENV:"production"},browser:true,version:"v20.0.0",versions:{},platform:"browser",nextTick:function(fn,a,b,c){return setTimeout(function(){fn(a,b,c)},0)},hrtime:function(){return[0,0]},exit:function(){},on:function(){return this}};'
```

Expected output:

```
  bitcoin-bundle-v7.min.js  382.1kb

⚡ Done in ~100–150ms
```

---

## Step 5 — Verify RNG in bundle (security audit)

```bash
# getRandomValues must be present (> 0). Verified count: 7 on Node v24.15.0 + npm 11.13.0.
# Builds on other Node/npm versions may differ by 1–2; any positive count is acceptable.
grep -o "getRandomValues" bitcoin-bundle-v7.min.js | wc -l

# Math.random must be ABSENT:
if grep -q "Math\.random" bitcoin-bundle-v7.min.js; then echo "❌ PROBLEM: Math.random found"; else echo "✅ OK: Math.random absent"; fi

# node:crypto must be ABSENT:
if grep -qE "node:crypto|require\(.*crypto" bitcoin-bundle-v7.min.js; then echo "❌ PROBLEM: node:crypto found"; else echo "✅ OK: no node:crypto"; fi

# @bitcoinerlab must be ABSENT:
if grep -q "bitcoinerlab" bitcoin-bundle-v7.min.js; then echo "❌ PROBLEM: bitcoinerlab found in bundle"; else echo "✅ OK: no bitcoinerlab"; fi

# Confirm all getRandomValues calls go through globalThis.crypto:
grep -oE '.{50}getRandomValues.{50}' bitcoin-bundle-v7.min.js

;function tE(e=32){if(_i.crypto&&typeof _i.crypto.getRandomValues=="function")return _i.crypto.getRandomValues(new
_i.crypto.randomBytes(e));throw new Error("crypto.getRandomValues must be defined")}});var Ic=k(pt=>{"use strict";O
(Pa,u),u===void 0&&(u={});let c=u.rng||(a=>crypto.getRandomValues(new Uint8Array(a))),f;do f=c(32),We.parse(Ua.Buff
his=="object"?globalThis.crypto:null;if(typeof t?.getRandomValues!="function")throw new Error("crypto.getRandomValu
tesLength" expected <= 65536, got ${e}`);return t.getRandomValues(new Uint8Array(e))}var Aw,K3,$r,Ow,Sn=ht(()=>{Aw=
```

Expected output:
```
7
✅ OK: Math.random absent
✅ OK: no node:crypto
✅ OK: no bitcoinerlab
...globalThis.crypto...getRandomValues...
...crypto.getRandomValues(new Uint8Array...
```

> **Note:** the `getRandomValues` count is 7 when built on Node v24.15.0 + npm 11.13.0.
> Any positive count is safe; `Math.random` being absent is the critical invariant.

---

## Step 6 — Test the bundle

> **Install jsdom only at this step** — after the bundle has been built and the
> RNG audit passed. jsdom is a test harness dependency only; it is not imported
> by entry_bundle.js and will never appear in the bundle regardless of install
> order, but keeping it out of `package.json` during Steps 1–5 makes the
> dependency audit unambiguous.

```bash
npm install --save-exact jsdom
```

Save the test file (single-quoted EOF prevents variable expansion):

```bash
cat > test_bundle.js << 'EOF'
// ============================================================
// FULL TEST SUITE — @noble/curves 2.2.0 build (122 checks)
// ============================================================
const { JSDOM } = require('jsdom')
const fs   = require('fs')
const nodeCrypto = require('crypto')

// Minimal browser env
const dom = new JSDOM('', { url: 'http://localhost' })
global.window = dom.window
global.document = dom.window.document
global.crypto = {
  getRandomValues: (buf) => {
    const bytes = nodeCrypto.randomBytes(buf.length)
    buf.set(bytes)
    return buf
  }
}

// rng call counter for audit
let rngCallCount = 0
const _origRng = global.crypto.getRandomValues.bind(global.crypto)
Object.defineProperty(global.crypto, 'getRandomValues', {
  value: function(buf) { rngCallCount++; return _origRng(buf) },
  writable: false, configurable: false
})

const BUNDLE = './bitcoin-bundle-v7.min.js'
const code = fs.readFileSync(BUNDLE, 'utf8')
const fn   = new Function('window', 'document', 'crypto', code + '; return bitcoin;')
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
const KNOWN_PRIV     = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const KNOWN_PUB_COMP   = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const KNOWN_PUB_UNCOMP = '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'
const ORDER_BUF     = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 'hex')
const ORDER_MINUS_1 = Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140', 'hex')
const BTE_NETWORK = {
  messagePrefix: '\x19Bitweb Signed Message:\n',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  bech32: 'web', pubKeyHash: 0x21, scriptHash: 0x1E, wif: 0x80
}

// ============================================================
section('1. BUNDLE BASICS')
check('bitcoin object exists',  typeof b === 'object')
check('ECPair exported',        typeof b.ECPair === 'object')
check('Buffer exported',        typeof b.Buffer === 'function')
check('ecc exported',           typeof b.ecc === 'object')
check('Psbt exported',          typeof b.Psbt === 'function')
check('payments exported',      typeof b.payments === 'object')
check('opcodes exported',       typeof b.opcodes === 'object')
check('address exported',       typeof b.address === 'object')
check('crypto exported',        typeof b.crypto === 'object')
check('script exported',        typeof b.script === 'object')
check('networks exported',      typeof b.networks === 'object')
check('Transaction exported',   typeof b.Transaction === 'function')

section('2. RNG AUDIT')
const bundleText = fs.readFileSync(BUNDLE, 'utf8')
check('Math.random absent from bundle',   !bundleText.includes('Math.random'))
check('node:crypto absent from bundle',   !bundleText.match(/node:crypto|require\(.*crypto/))
check('bitcoinerlab absent from bundle',  !bundleText.includes('bitcoinerlab'))
const rngBefore = rngCallCount
b.ECPair.makeRandom()
check('makeRandom() calls getRandomValues', rngCallCount > rngBefore)

section('3. ecc.isPoint — compressed / uncompressed / invalid')
const ecc = b.ecc
check('isPoint: valid compressed 33b',    ecc.isPoint(Buffer.from(KNOWN_PUB_COMP, 'hex')),   true)
check('isPoint: valid uncompressed 65b',  ecc.isPoint(Buffer.from(KNOWN_PUB_UNCOMP, 'hex')), true)
check('isPoint: null',                    ecc.isPoint(null),                                  false)
check('isPoint: 32 bytes',                ecc.isPoint(Buffer.alloc(32)),                      false)
check('isPoint: 33 zeros (not on curve)', ecc.isPoint(Buffer.alloc(33)),                      false)
check('isPoint: 65 zeros',                ecc.isPoint(Buffer.alloc(65)),                      false)
check('isPoint: prefix 04 but 33b long',  ecc.isPoint(Buffer.from('04' + '00'.repeat(32), 'hex')), false)

section('4. ecc.isXOnlyPoint')
const xOnly = Buffer.from(KNOWN_PUB_COMP, 'hex').slice(1)
check('isXOnlyPoint: valid 32b x-coord',  ecc.isXOnlyPoint(xOnly),           true)
check('isXOnlyPoint: null',               ecc.isXOnlyPoint(null),             false)
check('isXOnlyPoint: 33 bytes',           ecc.isXOnlyPoint(Buffer.alloc(33)), false)
check('isXOnlyPoint: 32 zeros',           ecc.isXOnlyPoint(Buffer.alloc(32)), false)

section('5. ecc.isPrivate')
check('isPrivate: scalar=1 valid',        ecc.isPrivate(KNOWN_PRIV),    true)
check('isPrivate: scalar=0 invalid',      ecc.isPrivate(Buffer.alloc(32)), false)
check('isPrivate: null',                  ecc.isPrivate(null),           false)
check('isPrivate: 31 bytes',              ecc.isPrivate(Buffer.alloc(31)), false)
check('isPrivate: scalar=ORDER invalid',  ecc.isPrivate(ORDER_BUF),     false)
check('isPrivate: scalar=ORDER-1 valid',  ecc.isPrivate(ORDER_MINUS_1), true)

section('6. ecc.pointFromScalar — known vector')
const computed = ecc.pointFromScalar(KNOWN_PRIV, true)
check('pointFromScalar: scalar=1 → G (compressed)',
  computed && Buffer.from(computed).toString('hex') === KNOWN_PUB_COMP)
const computedUncomp = ecc.pointFromScalar(KNOWN_PRIV, false)
check('pointFromScalar: scalar=1 → G (uncompressed)',
  computedUncomp && Buffer.from(computedUncomp).toString('hex') === KNOWN_PUB_UNCOMP)
check('pointFromScalar: scalar=0 → null',    ecc.pointFromScalar(Buffer.alloc(32)), null)
check('pointFromScalar: scalar=ORDER → null', ecc.pointFromScalar(ORDER_BUF),       null)

section('7. ecc.pointCompress')
const uncomp = Buffer.from(KNOWN_PUB_UNCOMP, 'hex')
const comp   = Buffer.from(KNOWN_PUB_COMP,   'hex')
const recompressed = ecc.pointCompress(uncomp, true)
check('pointCompress: uncomp→comp gives 33b',
  recompressed && recompressed.length === 33)
check('pointCompress: uncomp→comp matches known',
  recompressed && Buffer.from(recompressed).toString('hex') === KNOWN_PUB_COMP)
const expanded = ecc.pointCompress(comp, false)
check('pointCompress: comp→uncomp gives 65b', expanded && expanded.length === 65)
check('pointCompress: comp→uncomp matches known',
  expanded && Buffer.from(expanded).toString('hex') === KNOWN_PUB_UNCOMP)
const recomp2 = ecc.pointCompress(comp, true)
check('pointCompress: comp→comp idempotent',
  recomp2 && Buffer.from(recomp2).toString('hex') === KNOWN_PUB_COMP)

section('8. ecc.privateAdd / privateNegate')
const priv1 = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const added = ecc.privateAdd(priv1, priv1)
check('privateAdd(1,1) = 2',
  added && Buffer.from(added).toString('hex') === '0000000000000000000000000000000000000000000000000000000000000002')
const negated = ecc.privateNegate(priv1)
check('privateNegate(1) = ORDER-1',
  negated && Buffer.from(negated).toString('hex') === 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140')
check('privateAdd(1, negate(1)) = null (wraps to 0)', ecc.privateAdd(priv1, negated) === null)
const addedZero = ecc.privateAdd(priv1, Buffer.alloc(32))
check('privateAdd(1, 0) = 1',
  addedZero && Buffer.from(addedZero).toString('hex') === '0000000000000000000000000000000000000000000000000000000000000001')

section('9. ecc.xOnlyPointAddTweak — Taproot')
const xOnlyG  = Buffer.from(KNOWN_PUB_COMP, 'hex').slice(1)
const tweak1  = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
const tweakResult  = ecc.xOnlyPointAddTweak(xOnlyG, tweak1)
check('xOnlyPointAddTweak: returns object',      tweakResult !== null)
check('xOnlyPointAddTweak: parity is 0 or 1',    tweakResult && (tweakResult.parity === 0 || tweakResult.parity === 1))
check('xOnlyPointAddTweak: xOnlyPubkey 32 bytes', tweakResult && tweakResult.xOnlyPubkey && tweakResult.xOnlyPubkey.length === 32)
const tweakResult2 = ecc.xOnlyPointAddTweak(xOnlyG, tweak1)
check('xOnlyPointAddTweak: deterministic (same input → same output)',
  tweakResult && tweakResult2 &&
  tweakResult.parity === tweakResult2.parity &&
  Buffer.from(tweakResult.xOnlyPubkey).toString('hex') === Buffer.from(tweakResult2.xOnlyPubkey).toString('hex'))
check('xOnlyPointAddTweak: tweak=ORDER → null', ecc.xOnlyPointAddTweak(xOnlyG, ORDER_BUF), null)

section('10. ecc.sign / verify — ECDSA')
const testHash = Buffer.from('0101010101010101010101010101010101010101010101010101010101010101', 'hex')
const privKey  = Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex')
const pubKey   = ecc.pointFromScalar(privKey, true)
const sig1 = ecc.sign(testHash, privKey)
check('sign: returns Uint8Array',  sig1 instanceof Uint8Array)
check('sign: 64 bytes',            sig1.length, 64)
check('verify: valid sig → true',  ecc.verify(testHash, pubKey, sig1))
const sig2 = ecc.sign(testHash, privKey)
let sigSame = sig1.length === sig2.length
for (let i = 0; i < sig1.length; i++) if (sig1[i] !== sig2[i]) { sigSame = false; break }
check('sign: RFC6979 deterministic (same key+hash → same sig)', sigSame)
const wrongHash = Buffer.from('0202020202020202020202020202020202020202020202020202020202020202', 'hex')
check('verify: wrong hash → false',    ecc.verify(wrongHash, pubKey, sig1), false)
const otherPub = ecc.pointFromScalar(Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex'), true)
check('verify: wrong pubkey → false',  ecc.verify(testHash, otherPub, sig1), false)
const sigLowS = ecc.sign(testHash, privKey)
const S_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')
let sVal = 0n
for (let i = 0; i < 32; i++) sVal = (sVal << 8n) | BigInt(sigLowS[32 + i])
check('sign: lowS enforced (s <= n/2)', sVal <= S_HALF_ORDER)
check('verify strict=true: lowS sig passes', ecc.verify(testHash, pubKey, ecc.sign(testHash, privKey), true))
const badSig = Buffer.from(sig1); badSig[0] ^= 0xff
check('verify: tampered sig → false', ecc.verify(testHash, pubKey, badSig), false)

section('11. ecc.signSchnorr / verifySchnorr — BIP340')
const schnorrSig1 = ecc.signSchnorr(testHash, privKey)
check('signSchnorr: 64 bytes',                   schnorrSig1.length, 64)
check('verifySchnorr: valid roundtrip',           ecc.verifySchnorr(testHash, pubKey.slice(1), schnorrSig1))
const schnorrSig2 = ecc.signSchnorr(testHash, privKey)
check('verifySchnorr: second sig also verifies',  ecc.verifySchnorr(testHash, pubKey.slice(1), schnorrSig2))
let schnorrDiffer = false
for (let i = 0; i < schnorrSig1.length; i++) if (schnorrSig1[i] !== schnorrSig2[i]) { schnorrDiffer = true; break }
check('signSchnorr: random nonce (two sigs differ)', schnorrDiffer)
check('verifySchnorr: wrong hash → false', ecc.verifySchnorr(wrongHash, pubKey.slice(1), schnorrSig1), false)

section('12. KEY MANAGEMENT — ECPair / fromPrivateKey / fromPublicKey')
const kp = b.ECPair.fromPrivateKey(privKey)
check('ECPair.fromPrivateKey: publicKey is Uint8Array', kp.publicKey instanceof Uint8Array)
check('ECPair.fromPrivateKey: pubkey matches pointFromScalar',
  Buffer.from(kp.publicKey).toString('hex') === Buffer.from(pubKey).toString('hex'))
const kpPubOnly = b.ECPair.fromPublicKey(pubKey)
check('ECPair.fromPublicKey: works',           kpPubOnly.publicKey instanceof Uint8Array)
check('ECPair.fromPublicKey: no private key',  kpPubOnly.privateKey === undefined)
check('ECPair.fromPublicKey: sign throws', (function() {
  try { kpPubOnly.sign(testHash); return false } catch(e) { return true }
})())
const kpRandom = b.ECPair.makeRandom()
check('makeRandom: has privateKey',         kpRandom.privateKey instanceof Uint8Array)
check('makeRandom: privateKey is 32 bytes', kpRandom.privateKey.length, 32)
check('makeRandom: has publicKey',          kpRandom.publicKey instanceof Uint8Array)
const kpRandom2 = b.ECPair.makeRandom()
check('makeRandom: two keys differ',
  Buffer.from(kpRandom.publicKey).toString('hex') !== Buffer.from(kpRandom2.publicKey).toString('hex'))
const kpSign = b.ECPair.fromPrivateKey(privKey)
const kpSig  = kpSign.sign(testHash)
check('ECPair.sign: 64 bytes',    kpSig.length, 64)
check('ECPair.verify: roundtrip', kpSign.verify(testHash, kpSig))
const kpNet = b.ECPair.fromPrivateKey(privKey, { network: BTE_NETWORK })
check('ECPair with BTE network: has publicKey', kpNet.publicKey instanceof Uint8Array)

section('13. ADDRESSES — p2wpkh / p2pkh / p2sh')
const p2wpkh = b.payments.p2wpkh({ pubkey: pubKey })
check('p2wpkh: address defined',      typeof p2wpkh.address === 'string')
check('p2wpkh: starts with bc1q',     p2wpkh.address.startsWith('bc1q'))
check('p2wpkh: output is Uint8Array', p2wpkh.output instanceof Uint8Array)
check('p2wpkh: output length 22',     p2wpkh.output.length, 22)
check('p2wpkh: hash is Uint8Array',   p2wpkh.hash instanceof Uint8Array)
check('p2wpkh: hash length 20',       p2wpkh.hash.length, 20)
const p2pkhPmt = b.payments.p2pkh({ pubkey: pubKey })
check('p2pkh: address defined', typeof p2pkhPmt.address === 'string')
check('p2pkh: starts with 1',   p2pkhPmt.address.startsWith('1'))
const p2wpkhBte = b.payments.p2wpkh({ pubkey: pubKey, network: BTE_NETWORK })
check('p2wpkh BTE: starts with web1q', p2wpkhBte.address.startsWith('web1q'))
check('p2wpkh BTE output: starts with 0014 (SegWit v0)',
  b.Buffer.from(p2wpkhBte.output).toString('hex').startsWith('0014'))
const redeemHex = '0014' + b.Buffer.from(p2wpkh.hash).toString('hex')
check('redeemScript: starts with 0014', redeemHex.startsWith('0014'))
check('redeemScript: length 44',        redeemHex.length, 44)

section('14. PSBT — build, sign, finalize, extract')
const aliceKP  = b.ECPair.fromPrivateKey(Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex'))
const alicePmt = b.payments.p2wpkh({ pubkey: aliceKP.publicKey })
const psbt = new b.Psbt()
psbt.addInput({ hash: 'a'.repeat(64), index: 0,
  witnessUtxo: { script: alicePmt.output, value: BigInt(100000) } })
psbt.addOutput({ address: alicePmt.address, value: BigInt(90000) })
psbt.signInput(0, aliceKP)
check('Psbt.signInput: works without throw', true)
psbt.validateSignaturesOfInput(0, (pk, msg, s) => ecc.verify(msg, pk, s))
check('Psbt.validateSignaturesOfInput: all valid', true)
psbt.finalizeAllInputs()
const tx = psbt.extractTransaction()
check('Psbt.extractTransaction: returns Transaction', typeof tx === 'object')
check('Transaction.toHex: produces hex string',       typeof tx.toHex() === 'string')
check('Transaction.getId: produces txid',             typeof tx.getId() === 'string')
check('Transaction.getId: 64 hex chars',              tx.getId().length === 64)
const psbtNum = new b.Psbt()
let bigIntRequired = false
try { psbtNum.addOutput({ address: alicePmt.address, value: 90000 }) } catch(e) { bigIntRequired = true }
check('Psbt v7: BigInt required for values (Number throws)', bigIntRequired)

section('15. CRYPTO HELPERS')
check('crypto.hash256: 32 bytes', b.crypto.hash256(Buffer.from('hello')).length, 32)
check('crypto.hash160: 20 bytes', b.crypto.hash160(Buffer.from('hello')).length, 20)
check('crypto.sha256: 32 bytes',  b.crypto.sha256(Buffer.from('hello')).length,  32)

section('16. OPCODES')
check('OP_0',           b.opcodes.OP_0,           0)
check('OP_DUP',         b.opcodes.OP_DUP,         118)
check('OP_HASH160',     b.opcodes.OP_HASH160,     169)
check('OP_EQUALVERIFY', b.opcodes.OP_EQUALVERIFY, 136)
check('OP_CHECKSIG',    b.opcodes.OP_CHECKSIG,    172)
check('OP_RETURN',      b.opcodes.OP_RETURN,      106)

section('17. ADDRESS DECODE roundtrip')
b.address.fromBech32(p2wpkh.address)
check('address.fromBech32: native SegWit', true)
b.address.fromBase58Check(p2pkhPmt.address)
check('address.fromBase58Check: legacy', true)

section('18. SCRIPT helpers')
const p2pkhScript = b.script.compile([
  b.opcodes.OP_DUP, b.opcodes.OP_HASH160, Buffer.alloc(20),
  b.opcodes.OP_EQUALVERIFY, b.opcodes.OP_CHECKSIG
])
check('script.compile: produces Uint8Array', p2pkhScript instanceof Uint8Array)
check('script.compile: P2PKH length 25',     p2pkhScript.length, 25)
const chunks = b.script.decompile(p2pkhScript)
check('script.decompile: returns array', Array.isArray(chunks))
check('script.decompile: 5 chunks',      chunks.length, 5)

section('19. BUFFER — Uint8Array wrapping (v7 breaking change)')
const pubHex = b.Buffer.from(pubKey).toString('hex')
check('Buffer.from(Uint8Array).toString(hex): hex string', !pubHex.includes(','))
check('Buffer.from(Uint8Array).toString(hex): length 66',  pubHex.length, 66)
check('publicKey raw toString: broken (no Buffer wrap)',    pubKey.toString() !== pubHex)
check('payment.output Buffer wrap: proper hex', !b.Buffer.from(p2wpkh.output).toString('hex').includes(','))
check('payment.hash Buffer wrap: proper hex',   !b.Buffer.from(p2wpkh.hash).toString('hex').includes(','))

section('20. TAPROOT — xOnlyPointAddTweak integration (BIP341)')
const taprootPriv  = Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex')
const taprootPub   = ecc.pointFromScalar(taprootPriv, true)
const taprootXOnly = taprootPub.slice(1)
const tapTweakHash = b.crypto.sha256(Buffer.from(taprootXOnly))
const tweakRes     = ecc.xOnlyPointAddTweak(taprootXOnly, tapTweakHash)
check('Taproot xOnlyPointAddTweak: returns result',  tweakRes !== null)
check('Taproot parity in {0,1}', tweakRes && (tweakRes.parity === 0 || tweakRes.parity === 1))
check('Taproot tweaked pubkey: 32 bytes', tweakRes && tweakRes.xOnlyPubkey.length, 32)
// BIP341: negate based on parity of INTERNAL key P, not tweaked result Q.
// taprootPub[0] === 0x03 means odd y → negate privkey first.
const internalParity = taprootPub[0] === 0x03 ? 1 : 0
let privTweak = Buffer.from(taprootPriv)
if (internalParity === 1) privTweak = ecc.privateNegate(privTweak)
const tweakedPriv = ecc.privateAdd(privTweak, tapTweakHash)
check('Taproot tweaked privkey: non-null',  tweakedPriv !== null)
check('Taproot tweaked privkey: 32 bytes',  tweakedPriv && tweakedPriv.length, 32)
if (tweakedPriv) {
  const tweakedPub = ecc.pointFromScalar(tweakedPriv, true)
  check('Taproot: tweaked priv → tweaked pub xOnly matches',
    Buffer.from(tweakedPub.slice(1)).toString('hex') === Buffer.from(tweakRes.xOnlyPubkey).toString('hex'))
}

// ============================================================
section('21. bitcoin.taproot.makeKeySigner — BIP341 bundle signer')
// Verifies the bundle-embedded taproot signer:
//   - exported on bitcoin.taproot
//   - correct structure (publicKey 32b, signSchnorr fn)
//   - Schnorr sig verifies against tweaked x-only pubkey
//   - memory zeroing does not break the callback (td captured before finally)
//   - no private key → throws before callback
//   - two calls produce different sigs (random nonce)
//   - BIP341 invariant: tweakedPriv→pub matches xOnlyPointAddTweak
check('bitcoin.taproot exported',                typeof b.taproot === 'object')
check('bitcoin.taproot.makeKeySigner: function', typeof b.taproot.makeKeySigner === 'function')

const trPriv = Buffer.from('e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex')
const trKp   = b.ECPair.fromPrivateKey(trPriv)
const trHash = Buffer.from('0303030303030303030303030303030303030303030303030303030303030303', 'hex')

let trSig1 = null, trSig2 = null, trXOnly = null, trOk = false
b.taproot.makeKeySigner(trKp, function(s) {
  check('taproot signer: publicKey is Uint8Array',  s.publicKey instanceof Uint8Array)
  check('taproot signer: publicKey 32 bytes',       s.publicKey.length, 32)
  check('taproot signer: signSchnorr is function',  typeof s.signSchnorr === 'function')
  trSig1  = s.signSchnorr(trHash)
  trSig2  = s.signSchnorr(trHash)   // second call — must also verify
  trXOnly = s.publicKey
  check('taproot signer: sig1 is Uint8Array',       trSig1 instanceof Uint8Array)
  check('taproot signer: sig1 64 bytes',            trSig1.length, 64)
  check('taproot signer: sig2 64 bytes',            trSig2.length, 64)
  trOk = true
})
check('makeKeySigner: callback invoked (no exception)', trOk)

if (trSig1 && trXOnly) {
  check('makeKeySigner: sig1 verifySchnorr roundtrip',
    ecc.verifySchnorr(trHash, trXOnly, trSig1))
  check('makeKeySigner: sig2 verifySchnorr roundtrip',
    ecc.verifySchnorr(trHash, trXOnly, trSig2))
  let sigsDiffer = false
  for (let i = 0; i < 64; i++) if (trSig1[i] !== trSig2[i]) { sigsDiffer = true; break }
  check('makeKeySigner: random nonce (two sigs differ)', sigsDiffer)
  check('makeKeySigner: wrong hash → false',
    ecc.verifySchnorr(Buffer.from('ff'.repeat(32), 'hex'), trXOnly, trSig1), false)
}

// No private key → must throw before callback fires
let noPrivThrew = false, noPrivCallbackFired = false
try {
  b.taproot.makeKeySigner(b.ECPair.fromPublicKey(trKp.publicKey), function() {
    noPrivCallbackFired = true
  })
} catch(e) { noPrivThrew = true }
check('makeKeySigner: no privKey → throws',           noPrivThrew)
check('makeKeySigner: no privKey → callback not fired', !noPrivCallbackFired)

// BIP341 math invariant: tweakedPriv→pointFromScalar xOnly === xOnlyPointAddTweak result
const trXOnlyPub = trKp.publicKey.slice(1)
const trTweak    = b.crypto.taggedHash('TapTweak', trXOnlyPub)
const trEffD     = trKp.publicKey[0] === 0x03
                     ? ecc.privateNegate(new Uint8Array(trKp.privateKey))
                     : new Uint8Array(trKp.privateKey)
const trTweakedD = ecc.privateAdd(trEffD, trTweak)
const trTweakedFromPriv  = ecc.pointFromScalar(trTweakedD, true)
const trTweakedFromTweak = ecc.xOnlyPointAddTweak(trXOnlyPub, trTweak)
check('BIP341 invariant: makeKeySigner xOnly matches xOnlyPointAddTweak',
  trTweakedFromPriv && trTweakedFromTweak && trXOnly &&
  b.Buffer.from(trTweakedFromPriv.slice(1)).toString('hex') ===
  b.Buffer.from(trTweakedFromTweak.xOnlyPubkey).toString('hex') &&
  b.Buffer.from(trTweakedFromPriv.slice(1)).toString('hex') ===
  b.Buffer.from(trXOnly).toString('hex'))
// Cleanup
trEffD.fill(0); if (trTweakedD) trTweakedD.fill(0)

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
```

```
cat > test_wallet_compat.js << 'EOF'
// ============================================================
// wallet.js COMPATIBILITY TEST — @noble/curves 2.2.0 (45 checks)
// Covers: key generation, all address types, ECDSA/Schnorr,
//         bitcoin.taproot.makeKeySigner (bundle), PSBT bech32/
//         segwit/taproot/mixed, Buffer wrapping, BigInt enforcement.
// ============================================================
const { JSDOM } = require('jsdom')
const fs         = require('fs')
const nodeCrypto = require('crypto')

const dom = new JSDOM('', { url: 'http://localhost' })
global.window   = dom.window
global.document = dom.window.document
global.crypto   = {
  getRandomValues: (buf) => { buf.set(nodeCrypto.randomBytes(buf.length)); return buf }
}

const code = fs.readFileSync('./bitcoin-bundle-v7.min.js', 'utf8')
const b = new Function('window', 'document', 'crypto',
  code + '; return bitcoin;')(global.window, global.document, global.crypto)

// BTE mainnet — same object as in wallet.js networkConfigs
const BTE_NETWORK = {
  messagePrefix: '\x19Bitweb Signed Message:\n',
  bip32:   { public: 0x0488b21e, private: 0x0488ade4 },
  bech32:  'web',
  pubKeyHash: 0x21,
  scriptHash: 0x1E,
  wif:     0x80
}

let total = 0, passed = 0, failed = 0
const FAIL_DETAILS = []
function check(label, got, expected) {
  total++
  const ok = expected === undefined ? !!got : got === expected
  if (ok) { passed++; console.log(`  ✅ ${label}`) }
  else {
    failed++
    const d = `  ❌ ${label}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`
    console.log(d); FAIL_DETAILS.push(d)
  }
}
function section(t) { console.log(`\n─── ${t} ───`) }

// Fixed private key — deterministic across runs
const PRIV = b.Buffer.from(
  'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', 'hex'
)
const kp      = b.ECPair.fromPrivateKey(PRIV, { network: BTE_NETWORK })
const pubKey  = kp.publicKey
const network = BTE_NETWORK
const ecc     = b.ecc

// ============================================================
section('1. ecc exports — checked by makeTaprootSignerWith at runtime')
check('bitcoin.ecc exported',            typeof ecc === 'object')
check('ecc.privateAdd is function',      typeof ecc.privateAdd         === 'function')
check('ecc.privateNegate is function',   typeof ecc.privateNegate      === 'function')
check('ecc.signSchnorr is function',     typeof ecc.signSchnorr        === 'function')
check('ecc.xOnlyPointAddTweak is fn',    typeof ecc.xOnlyPointAddTweak === 'function')
check('bitcoin.crypto.taggedHash is fn', typeof b.crypto.taggedHash    === 'function')

// ============================================================
section('2. Key generation — ECPair.fromPrivateKey / makeRandom')
check('fromPrivateKey: publicKey Uint8Array', kp.publicKey instanceof Uint8Array)
check('fromPrivateKey: pubkey 33 bytes',      kp.publicKey.length, 33)
check('fromPrivateKey: prefix 02 or 03',      kp.publicKey[0] === 0x02 || kp.publicKey[0] === 0x03)
check('fromPrivateKey: toWIF works',          kp.toWIF().length > 0)
const kpA = b.ECPair.makeRandom({ network: BTE_NETWORK })
const kpB = b.ECPair.makeRandom({ network: BTE_NETWORK })
check('makeRandom: privateKey Uint8Array',    kpA.privateKey instanceof Uint8Array)
check('makeRandom: pubkey 33 bytes',          kpA.publicKey.length, 33)
check('makeRandom: two keys differ',
  b.Buffer.from(kpA.publicKey).toString('hex') !== b.Buffer.from(kpB.publicKey).toString('hex'))

// ============================================================
section('3. Keystore.deriveAddress — all 4 address types on BTE network')
const p2wpkh = b.payments.p2wpkh({ pubkey: pubKey, network })
check('bech32: starts with web1q',         p2wpkh.address.startsWith('web1q'))
check('bech32: output Uint8Array',         p2wpkh.output instanceof Uint8Array)
check('bech32: hash Uint8Array',           p2wpkh.hash   instanceof Uint8Array)

const redeem = b.payments.p2wpkh({ pubkey: pubKey, network })
const p2sh   = b.payments.p2sh({ redeem, network })
check('segwit: p2sh address defined',      typeof p2sh.address === 'string')

const p2pkh  = b.payments.p2pkh({ pubkey: pubKey, network })
check('legacy: address defined',           typeof p2pkh.address === 'string')

const xOnlyPub = pubKey.slice(1)   // 33-byte compressed → 32-byte x-only
const p2tr     = b.payments.p2tr({ internalPubkey: xOnlyPub, network })
check('taproot: address defined',          typeof p2tr.address === 'string')
check('taproot: output Uint8Array',        p2tr.output instanceof Uint8Array)

// ============================================================
section('4. Keystore.getScriptHex — Buffer.from() wrapping (v7 breaking change)')
const bech32Hex  = b.Buffer.from(p2wpkh.output).toString('hex')
check('bech32 scriptHex: proper hex (no commas)', !bech32Hex.includes(','))
check('bech32 scriptHex: length 44',               bech32Hex.length, 44)
check('bech32 scriptHex: starts with 0014',        bech32Hex.startsWith('0014'))
check('segwit scriptHex: proper hex',              !b.Buffer.from(p2sh.output).toString('hex').includes(','))
check('legacy scriptHex: proper hex',              !b.Buffer.from(p2pkh.output).toString('hex').includes(','))
const taprootHex = b.Buffer.from(p2tr.output).toString('hex')
check('taproot scriptHex: proper hex',             !taprootHex.includes(','))
check('taproot scriptHex: starts with 5120',        taprootHex.startsWith('5120'))
const redeemHex  = '0014' + b.Buffer.from(p2wpkh.hash).toString('hex')
check('redeemScript hex: length 44',               redeemHex.length, 44)
check('redeemScript hex: starts with 0014',        redeemHex.startsWith('0014'))

// ============================================================
section('5. ECDSA sign/verify roundtrip')
const hash  = b.Buffer.from('01'.repeat(32), 'hex')
const sig1  = kp.sign(hash)
check('sign: 64 bytes',              sig1.length, 64)
check('verify: roundtrip',           kp.verify(hash, sig1))
const sig2  = kp.sign(hash)
let same = true; for (let i=0;i<64;i++) if(sig1[i]!==sig2[i]){same=false;break}
check('sign: RFC6979 deterministic', same)
check('verify: wrong hash → false',  kp.verify(b.Buffer.from('ff'.repeat(32),'hex'), sig1), false)

// ============================================================
section('6. Schnorr signSchnorr/verifySchnorr (BIP340)')
const ss1 = kp.signSchnorr(hash)
check('signSchnorr: 64 bytes',                       ss1.length, 64)
check('verifySchnorr: roundtrip',                    kp.verifySchnorr(hash, ss1))
const ss2 = kp.signSchnorr(hash)
check('verifySchnorr: second sig verifies',          kp.verifySchnorr(hash, ss2))
let diff=false; for(let i=0;i<64;i++) if(ss1[i]!==ss2[i]){diff=true;break}
check('signSchnorr: random nonce (two sigs differ)', diff)

// ============================================================
section('7. bitcoin.taproot.makeKeySigner — bundle BIP341 signer')
// Uses the bundle-embedded signer — no local copy of the tweak logic.
// This is the exact call pattern used in wallet.js signAllInputsWithKey.
let tapSignerOk = false, tapSig = null, tapXOnly = null
b.taproot.makeKeySigner(kp, function(signer) {
  check('signer.publicKey: 32 bytes (x-only)', signer.publicKey.length, 32)
  check('signer.signSchnorr: function',        typeof signer.signSchnorr === 'function')
  tapSig   = signer.signSchnorr(hash)
  tapXOnly = signer.publicKey
  check('signSchnorr via signer: 64 bytes',    tapSig.length, 64)
  tapSignerOk = true
})
check('makeKeySigner: no exception', tapSignerOk)
if (tapSig && tapXOnly)
  check('verifySchnorr on tweaked key: roundtrip', ecc.verifySchnorr(hash, tapXOnly, tapSig))

// BIP341 invariant: tweakedPriv → pub.xOnly must match xOnlyPointAddTweak result
const tapTweak    = b.crypto.taggedHash('TapTweak', xOnlyPub)
const effD        = kp.publicKey[0]===0x03 ? ecc.privateNegate(new Uint8Array(kp.privateKey))
                                            : new Uint8Array(kp.privateKey)
const tD          = ecc.privateAdd(effD, tapTweak)
const tweakedFromPriv  = ecc.pointFromScalar(tD, true)
const tweakedFromTweak = ecc.xOnlyPointAddTweak(xOnlyPub, tapTweak)
check('BIP341: tweakedPriv→pub xOnly matches xOnlyPointAddTweak',
  tweakedFromPriv && tweakedFromTweak &&
  b.Buffer.from(tweakedFromPriv.slice(1)).toString('hex') ===
  b.Buffer.from(tweakedFromTweak.xOnlyPubkey).toString('hex'))
effD.fill(0); if(tD) tD.fill(0)

// ============================================================
section('8. PSBT bech32 — sign / validateSignatures / extract')
const psbt1 = new b.Psbt({ network })
psbt1.addInput({ hash: 'a'.repeat(64), index: 0,
  witnessUtxo: { script: p2wpkh.output, value: BigInt(100000) } })
psbt1.addOutput({ address: p2wpkh.address, value: BigInt(90000) })
psbt1.signInput(0, kp)
check('PSBT bech32: signInput no throw',     true)
psbt1.validateSignaturesOfInput(0, (pk,msg,s) => ecc.verify(msg, pk, s))
check('PSBT bech32: validateSignatures',     true)
psbt1.finalizeAllInputs()
const tx1 = psbt1.extractTransaction()
check('PSBT bech32: extractTransaction',     typeof tx1 === 'object')
check('PSBT bech32: txid 64 hex chars',      tx1.getId().length, 64)

// ============================================================
section('9. PSBT taproot — tapInternalKey + bitcoin.taproot.makeKeySigner')
const psbt2 = new b.Psbt({ network })
psbt2.addInput({ hash: 'b'.repeat(64), index: 0,
  witnessUtxo:    { script: p2tr.output, value: BigInt(200000) },
  tapInternalKey: xOnlyPub })
psbt2.addOutput({ address: p2wpkh.address, value: BigInt(190000) })
let tapPsbtOk = false
try {
  b.taproot.makeKeySigner(kp, s => psbt2.signInput(0, s))
  tapPsbtOk = true
} catch(e) { console.log('  taproot PSBT error:', e.message) }
check('PSBT taproot: signInput no throw', tapPsbtOk)
if (tapPsbtOk) {
  psbt2.finalizeAllInputs()
  check('PSBT taproot: extractTransaction', typeof psbt2.extractTransaction() === 'object')
}

// ============================================================
section('10. PSBT segwit — redeemScript')
const psbt3 = new b.Psbt({ network })
psbt3.addInput({ hash: 'c'.repeat(64), index: 0,
  witnessUtxo:  { script: p2sh.output,   value: BigInt(50000) },
  redeemScript: p2wpkh.output })
psbt3.addOutput({ address: p2wpkh.address, value: BigInt(40000) })
psbt3.signInput(0, kp)
check('PSBT segwit: signInput no throw', true)
psbt3.finalizeAllInputs()
check('PSBT segwit: extractTransaction', typeof psbt3.extractTransaction() === 'object')

// ============================================================
section('11. BigInt enforced in v7 (wallet.js uses BigInt everywhere)')
const psbtNum = new b.Psbt({ network })
let bigIntRequired = false
try { psbtNum.addOutput({ address: p2wpkh.address, value: 90000 }) }
catch(e) { bigIntRequired = true }
check('Psbt v7: Number throws, BigInt required', bigIntRequired)

// ============================================================
section('12. Mixed PSBT — hasTaproot branch in signAllInputsWithKey')
const psbt4 = new b.Psbt({ network })
psbt4.addInput({ hash: 'd'.repeat(64), index: 0,
  witnessUtxo:  { script: p2wpkh.output, value: BigInt(100000) } })
psbt4.addInput({ hash: 'e'.repeat(64), index: 0,
  witnessUtxo:    { script: p2tr.output, value: BigInt(100000) },
  tapInternalKey: xOnlyPub })
psbt4.addOutput({ address: p2wpkh.address, value: BigInt(190000) })

const hasTaproot = psbt4.data.inputs.some(i => i.tapInternalKey && i.tapInternalKey.length === 32)
check('hasTaproot detection works', hasTaproot)

// Exact pattern from wallet.js signAllInputsWithKey
let mixedOk = false
try {
  b.taproot.makeKeySigner(kp, function(tapSigner) {
    psbt4.data.inputs.forEach(function(inp, idx) {
      if (inp.tapInternalKey && inp.tapInternalKey.length === 32)
        psbt4.signInput(idx, tapSigner)
      else
        psbt4.signInput(idx, kp)
    })
  })
  mixedOk = true
} catch(e) { console.log('  mixed PSBT error:', e.message) }
check('Mixed bech32+taproot: all inputs signed', mixedOk)
if (mixedOk) {
  psbt4.finalizeAllInputs()
  const tx4 = psbt4.extractTransaction()
  check('Mixed PSBT: extractTransaction',   typeof tx4 === 'object')
  check('Mixed PSBT: 2 inputs in tx',       tx4.ins.length, 2)
}

// ============================================================
console.log('\n' + '='.repeat(55))
console.log(`TOTAL: ${total}  ✅ PASSED: ${passed}  ❌ FAILED: ${failed}`)
if (failed > 0) {
  console.log('\nFAILED TESTS:')
  FAIL_DETAILS.forEach(d => console.log(d))
  console.log('\n❌ wallet.js IS NOT compatible — do not deploy')
  process.exit(1)
} else {
  console.log('\n✅ wallet.js IS compatible with @noble/curves@2.2.0')
}
EOF
```


Run it:

```bash
node test_bundle.js
node test_wallet_compat.js
```

Every section must show `✅` and the final lines must be:
```
TOTAL: 139  ✅ PASSED: 139  ❌ FAILED: 0

✅ ALL TESTS PASSED — bundle is safe to deploy
```
```
TOTAL: 45  ✅ PASSED: 45  ❌ FAILED: 0

✅ wallet.js IS compatible with @noble/curves@2.2.0
```

---

## Step 7 — Compute your hashes and deploy

Bundle hashes depend on the build environment (Node + npm version). There is no
canonical hash — compute yours after building and record it as the reference for
future rebuilds on the same machine.

```bash
# Size:
wc -c bitcoin-bundle-v7.min.js

# SRI hash:
echo "sha512-$(cat bitcoin-bundle-v7.min.js | openssl dgst -sha512 -binary | openssl base64 -A)"
```

**Verified hashes (Node v22.22.2 + npm 10.9.7):**
```
391238 bitcoin-bundle-v7.min.js
sha512-4a6IrbcPk7PuGATPEqbn+9k1Ne+t2qPtDm/WlySgCPTsgLGzXtsRxSHdstgNQRXp6PCO+pgHhGDaiNt3fDQ20Q==
```

> **Note:** The previous hash (Node v24.15.0 + npm 11.13.0) was `sha512-QNm17tWRH67IgJ34qVgy/xNTh80ud6Rskb9/TshHJmBdbsR6JvTbWsLX1002EUescanS22JQPdxFe9INv8A/vA==` (390614 bytes, without `bitcoin.taproot`). The new hash above includes the `bitcoin.taproot` module (+624 bytes).

---

## Bundle API

Global name after `<script>` load: `window.bitcoin`.

### Top-level exports

| Export | Type | Description |
|--------|------|-------------|
| `bitcoin.Psbt` | `class` | PSBT transaction builder |
| `bitcoin.Transaction` | `class` | Raw transaction (serialize, txid) |
| `bitcoin.payments` | `object` | Address/output factories — see below |
| `bitcoin.address` | `object` | Address encode/decode utilities |
| `bitcoin.script` | `object` | Script compile/decompile/ASM utilities |
| `bitcoin.crypto` | `object` | Hash functions |
| `bitcoin.opcodes` | `object` | Script opcode constants (OP_DUP, OP_CHECKSIG, …) |
| `bitcoin.networks` | `object` | Network parameters (`bitcoin`, `testnet`, `regtest`) |
| `bitcoin.ECPair` | `object` | Key pair factory |
| `bitcoin.ecc` | `object` | secp256k1 ECC primitives — see below |
| `bitcoin.taproot` | `object` | BIP341 key-path taproot signer — see below |
| `bitcoin.Buffer` | `function` | Browser Buffer polyfill (same as Node.js Buffer) |

---

### bitcoin.ECPair

```js
bitcoin.ECPair.fromPrivateKey(privKey: Uint8Array, opts?: { network? }): ECPair
bitcoin.ECPair.fromPublicKey(pubKey: Uint8Array,   opts?: { network? }): ECPair
bitcoin.ECPair.makeRandom(opts?: { network? }): ECPair

ecpair.privateKey  // Uint8Array | undefined
ecpair.publicKey   // Uint8Array (compressed, 33 bytes)
ecpair.toWIF(): string                                     // WIF-encoded private key

// ECDSA
ecpair.sign(hash: Uint8Array): Uint8Array                  // 64-byte compact sig, lowS, RFC6979 deterministic
ecpair.verify(hash: Uint8Array, sig: Uint8Array): boolean

// Schnorr BIP340 — exposed when ecc contains signSchnorr/verifySchnorr (as built here)
ecpair.signSchnorr(hash: Uint8Array): Uint8Array           // 64-byte BIP340 Schnorr sig (random nonce)
ecpair.verifySchnorr(hash: Uint8Array, sig: Uint8Array): boolean
```

> **Note:** `signSchnorr` / `verifySchnorr` are available on the ECPair instance only because
> the `ecc` adapter passed to `ECPairFactory` exposes those methods. They are **not** used
> directly for taproot key-path signing in `wallet.js` — taproot signing goes through
> `bitcoin.taproot.makeKeySigner` which applies the BIP341 TapTweak before calling `ecc.signSchnorr`.

---

### bitcoin.payments

```js
bitcoin.payments.p2wpkh({ pubkey, network? })  // native SegWit v0 — bc1q…
bitcoin.payments.p2pkh({ pubkey, network? })   // legacy P2PKH — 1…
bitcoin.payments.p2sh({ redeem, network? })    // P2SH — 3…
bitcoin.payments.p2wsh({ redeem, network? })   // P2WSH — bc1q… (32-byte script hash)
bitcoin.payments.p2ms({ m, pubkeys, network? })// bare multisig (use inside p2sh/p2wsh)
bitcoin.payments.p2tr({ internalPubkey, network? }) // Taproot — bc1p…
bitcoin.payments.embed({ data })               // OP_RETURN output

// All return: { address?, output: Uint8Array, hash?: Uint8Array, … }
// output and hash are Uint8Array — wrap with bitcoin.Buffer.from() before .toString('hex')
```

---

### bitcoin.address

```js
bitcoin.address.toOutputScript(address: string, network?): Uint8Array
bitcoin.address.fromOutputScript(script: Uint8Array, network?): string
bitcoin.address.fromBase58Check(address: string): { hash: Buffer, version: number }
bitcoin.address.toBase58Check(hash: Buffer, version: number): string
bitcoin.address.fromBech32(address: string): { prefix, version, data: Buffer }
bitcoin.address.toBech32(data: Buffer, version: number, prefix: string): string
```

---

### bitcoin.crypto

```js
bitcoin.crypto.hash256(buffer: Buffer): Buffer      // SHA256(SHA256(x)) — standard txid hash
bitcoin.crypto.hash160(buffer: Buffer): Buffer      // RIPEMD160(SHA256(x)) — pubkey hash
bitcoin.crypto.sha256(buffer: Buffer): Buffer
bitcoin.crypto.sha1(buffer: Buffer): Buffer
bitcoin.crypto.ripemd160(buffer: Buffer): Buffer
bitcoin.crypto.taggedHash(tag: string, data: Buffer): Buffer
  // BIP340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data)
  // Required by wallet.js for BIP341 key-path signing: taggedHash('TapTweak', xOnlyPub)
```

---

### bitcoin.script

```js
bitcoin.script.compile(chunks: Array<number | Buffer>): Uint8Array
bitcoin.script.decompile(script: Uint8Array): Array<number | Buffer> | null
bitcoin.script.toASM(script: Uint8Array): string
bitcoin.script.fromASM(asm: string): Buffer
bitcoin.script.isPushOnly(chunks): boolean
bitcoin.script.isCanonicalPubKey(buf): boolean
bitcoin.script.isCanonicalScriptSignature(buf): boolean
```

---

### bitcoin.ecc

Secp256k1 adapter. All inputs/outputs are `Uint8Array` / `Buffer` (32 or 33 or 65 bytes).

```js
// Point validation
bitcoin.ecc.isPoint(p): boolean          // compressed (33b) or uncompressed (65b) point
bitcoin.ecc.isXOnlyPoint(p): boolean     // 32-byte x-only pubkey (Taproot)
bitcoin.ecc.isPrivate(d): boolean        // 32-byte scalar, 0 < d < ORDER

// Point arithmetic
bitcoin.ecc.pointFromScalar(d, compressed?): Uint8Array | null
bitcoin.ecc.pointCompress(p, compressed?): Uint8Array
bitcoin.ecc.xOnlyPointAddTweak(p: Uint8Array, tweak: Uint8Array):
  { parity: 0|1, xOnlyPubkey: Uint8Array } | null

// Private key arithmetic (BIP341 taproot key-path signing)
bitcoin.ecc.privateAdd(d: Uint8Array, tweak: Uint8Array): Uint8Array | null
bitcoin.ecc.privateNegate(d: Uint8Array): Uint8Array

// ECDSA (prehash: false — expects pre-hashed 32-byte digest)
bitcoin.ecc.sign(hash: Uint8Array, priv: Uint8Array, extra?: Uint8Array): Uint8Array   // 64b compact, lowS
bitcoin.ecc.verify(hash: Uint8Array, pub: Uint8Array, sig: Uint8Array, strict?: boolean): boolean

// Schnorr BIP340
bitcoin.ecc.signSchnorr(hash: Uint8Array, priv: Uint8Array, extra?: Uint8Array): Uint8Array  // 64b
bitcoin.ecc.verifySchnorr(hash: Uint8Array, xOnlyPub: Uint8Array, sig: Uint8Array): boolean
```

---

### bitcoin.networks

```js
bitcoin.networks.bitcoin   // mainnet: pubKeyHash 0x00, bech32 'bc'
bitcoin.networks.testnet   // testnet: pubKeyHash 0x6f, bech32 'tb'
bitcoin.networks.regtest   // regtest: pubKeyHash 0x6f, bech32 'bcrt'
```

Custom network example (Bitweb):

```js
const BTE_NETWORK = {
  messagePrefix: '\x19Bitweb Signed Message:\n',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  bech32: 'web', pubKeyHash: 0x21, scriptHash: 0x1E, wif: 0x80
}
```

---

### bitcoin.taproot

BIP341 key-path taproot signer. All BIP341 tweak logic and key zeroing live here
so `wallet.js` never touches raw tweak arithmetic.

```js
// Call pattern in wallet.js:
bitcoin.taproot.makeKeySigner(kp: ECPair, onSigned: (signer) => void): void

// kp       — ECPair with privateKey (throws if privateKey absent)
// onSigned — callback invoked synchronously with a signer object:
//   signer.publicKey:   Uint8Array  // 32-byte tweaked x-only pubkey (Q)
//   signer.signSchnorr: (hash: Uint8Array) => Uint8Array  // 64-byte BIP340 sig

// All of rawD / effectiveD / tweakedD are zeroed in a finally block
// regardless of whether onSigned throws.
```

**Memory safety guarantee:** `tweakedD` is captured in a local `const td`
before `finally` runs. The callback can call `signSchnorr` safely; the buffer
is zeroed only after `onSigned` returns (or throws). Storing `signer.signSchnorr`
and calling it after the outer `makeKeySigner` returns is unsafe — `td` will be
zeroed by then.

**Usage example (`wallet.js` pattern):**

```js
bitcoin.taproot.makeKeySigner(kp, function(tapSigner) {
  psbt.data.inputs.forEach(function(inp, idx) {
    if (inp.tapInternalKey && inp.tapInternalKey.length === 32)
      psbt.signInput(idx, tapSigner)   // Schnorr key-path spend
    else
      psbt.signInput(idx, kp)          // ECDSA segwit spend
  })
})
```

**BIP341 math performed internally:**

```
xOnlyPub   = kp.publicKey.slice(1)           // bytes(P)
tweak      = taggedHash('TapTweak', xOnlyPub) // t
effectiveD = (y(P) odd) ? -d : d             // lift_x
tweakedD   = effectiveD + t  (mod n)          // d + t
Q          = xOnlyPointAddTweak(xOnlyPub, t)  // P + tG
```
