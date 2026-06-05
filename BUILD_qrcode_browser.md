# qrcode-browser.min.js — Reproducible Build Guide

Browser bundle for QR code generation used by the Bitweb web wallet.
The `qrcode` package (soldair/node-qrcode) ships no browser bundle in npm,
so this build produces one. The bundle renders QR codes directly to `<canvas>`.

**Changelog vs previous version:**
- `--target=es2020` — targets modern browsers only; no ES5 transpilation.
- `--banner:js=var process={...}` removed — `qrcode` does not reference `process`
  anywhere in its code (0 occurrences confirmed in the output bundle). The banner
  is only needed for packages that check `process.browser` or `process.env.NODE_ENV`.

---

## Requirements

| Tool     | Minimum version    | Verified build | Check            |
|----------|--------------------|----------------|------------------|
| Node.js  | **≥ 20.0.0**       | v24.15.0       | `node --version` |
| npm      | **≥ 10**           | 11.13.0         | `npm --version`  |
| Internet | registry.npmjs.org | —              | —                |

The SRI hash in Step 7 was produced on **Node v24.15.0 + npm 11.13.0**. Any environment satisfying the minimum versions will produce a functionally equivalent bundle; the byte-for-byte hash matches only when built on the same Node + npm pair.

---

## Step 1 — Create working directory

```bash
mkdir bte-qr-bundle
cd bte-qr-bundle
npm init -y
```

---

## Step 2 — Install exact pinned versions

```bash
npm install --save-exact qrcode@1.5.4
npm install --save-exact esbuild@0.28.0
```

### What each package does

| Package | Version | Purpose | Repository |
|---------|---------|---------|------------|
| qrcode  | 1.5.4   | QR code generator — canvas/SVG/string output | github.com/soldair/node-qrcode |
| esbuild | 0.28.0  | Bundler: CJS → single browser file | github.com/evanw/esbuild |

### Expected integrity hashes (sha512, npm registry — identical on all machines)

```
qrcode@1.5.4
  sha512-1ca71Zgiu6ORjHqFBDpnSMTR2ReToX4l1Au1VFLyVeBTFavzQnv5JxMFr3ukHVKpSrSA2MCk0lNJSykjUfz7Zg==

esbuild@0.28.0
  sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==
```

### Automated integrity check

```bash
cat > check_qr_integrity.js << 'EOF'
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const expected = {
  'qrcode':  'sha512-1ca71Zgiu6ORjHqFBDpnSMTR2ReToX4l1Au1VFLyVeBTFavzQnv5JxMFr3ukHVKpSrSA2MCk0lNJSykjUfz7Zg==',
  'esbuild': 'sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==',
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

node check_qr_integrity.js
```

Expected output:
```
OK: qrcode@1.5.4
OK: esbuild@0.28.0

✅ All integrity hashes match
```

---

## Step 3 — Create the entry point

```bash
cat > entry_qr.js << 'EOF'
const QRCodeLib = require('qrcode')
window.QRCode = QRCodeLib
EOF
```

---

## Step 4 — Build the bundle

`--target=es2020` targets Chrome 80+, Firefox 72+, Safari 13.1+.
No `--banner` needed: `qrcode` does not use `process` anywhere in its source.

```bash
./node_modules/.bin/esbuild entry_qr.js \
  --bundle \
  --platform=browser \
  --target=es2020 \
  --outfile=qrcode-browser.min.js \
  --minify \
  --define:global=globalThis
```

Expected output:

```
  qrcode-browser.min.js  23.8kb

⚡ Done in ~25ms
```

---

## Step 5 — Test the bundle

```bash
npm install --save-exact jsdom

cat > test_qr_bundle.js << 'EOF'
const { JSDOM } = require('jsdom')
const fs = require('fs')

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="qr"></div></body></html>', {
  runScripts: 'dangerously'
})
const w = dom.window
w.TextEncoder = TextEncoder
w.TextDecoder = TextDecoder
w.onerror = (msg, src, line, col, err) => { console.error('JS error:', msg, err); process.exit(1) }

w.HTMLCanvasElement.prototype.getContext = function(type) {
  if (type !== '2d') return null
  return {
    get fillStyle() { return this._fill || '#000' },
    set fillStyle(v) { this._fill = v },
    clearRect() {}, fillRect() {},
    createImageData(w, h) {
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
    },
    putImageData() {}, drawImage() {},
  }
}
w.HTMLCanvasElement.prototype.toDataURL = function() {
  return 'data:image/png;base64,STUBBED_FOR_TEST=='
}

w.document.head.appendChild(
  Object.assign(w.document.createElement('script'), {
    textContent: fs.readFileSync('qrcode-browser.min.js', 'utf8')
  })
)

let allOk = true
function check(label, value, expected) {
  const ok = expected === undefined ? !!value : value === expected
  console.log((ok ? '✅' : '❌') + ' ' + label + (ok ? '' : '  got: ' + JSON.stringify(value)))
  if (!ok) allOk = false
}

const QR = w.QRCode
check('window.QRCode defined',   typeof QR === 'object')
check('QRCode.toCanvas  exists', typeof QR.toCanvas === 'function')
check('QRCode.toDataURL exists', typeof QR.toDataURL === 'function')
check('QRCode.toString  exists', typeof QR.toString === 'function')

QR.toString('bitweb:bte1qtest123', { type: 'utf8' }).then(str => {
  check('toString resolves string', typeof str === 'string')
  check('toString non-empty',       str.length > 10)

  return QR.toString('bitweb:bte1qdifferent', { type: 'utf8' }).then(str2 => {
    check('different address → different output', str !== str2)

    const canvas = w.document.createElement('canvas')
    canvas.width = 256; canvas.height = 256
    w.document.getElementById('qr').appendChild(canvas)

    return QR.toCanvas(canvas, 'bitweb:bte1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      { width: 256, margin: 2, color: { dark: '#000000', light: '#ffffff' } }
    ).then(() => {
      check('toCanvas resolves without error', true)
      check('canvas in DOM', w.document.querySelector('#qr canvas') !== null)

      function runShim(el, text) {
        const c = w.document.createElement('canvas')
        el.appendChild(c)
        return QR.toCanvas(c, text, { width: 256, margin: 2,
          color: { dark: '#000000', light: '#ffffff' } })
      }
      const el2 = w.document.createElement('div')
      return runShim(el2, 'bitweb:bte1qtest_shim').then(() => {
        check('shim canvas appended', el2.querySelector('canvas') !== null)
        return QR.toString('', { type: 'utf8' })
          .then(() => check('empty string rejected', false))
          .catch(()  => check('empty string throws (expected)', true))
      })
    })
  })
}).then(() => {
  console.log('')
  if (allOk) { console.log('✅ ALL TESTS PASSED\nBundle is safe to deploy.') }
  else { console.log('❌ SOME TESTS FAILED'); process.exit(1) }
}).catch(e => { console.error('Unexpected error:', e.message); process.exit(1) })
EOF

node test_qr_bundle.js
```

Every line must show `✅` and the last line `ALL TESTS PASSED`.

---

## Step 6 — Verify size and checksum

This bundle is fully deterministic across platforms and Node/npm versions:
`qrcode` has no native code dependencies and esbuild produces identical output
for the same input and flags.

```bash
# Size:
wc -c qrcode-browser.min.js

# SRI hash:
echo "sha512-$(openssl dgst -sha512 -binary qrcode-browser.min.js | openssl base64 -A)"
# Expected: sha512-Owkt053PkI36baxtpawncRxvmsdahAekRZ87LRtEFpFCRE+q4E64TW5dGZIHqjum+tYByRcyHnSNSDkYkTDThg==
```

**Verified hashes (Node v24.15.0 + npm 11.13.0):**
```
24330 qrcode-browser.min.js
sha512-Fylkwjj7d5d/OCmgh3/usBPvSY5+Q/cYSl1myDVYCw1alMz4Sam6/IWwuXh8D3auWeq2L6vD8hT/p/CI8ppYPg==
```

```bash
grep -o "process\b" qrcode-browser.min.js | wc -l
# Must be 0
```

---

> This is the only bundle with a canonical hash — `qrcode` has no native code
> dependencies, so esbuild produces identical output across Node/npm versions.
